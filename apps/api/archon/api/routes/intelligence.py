"""Chat, docs, retrieval index, and reasoning workflows."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from archon.analysis.base import AnalysisContext
from archon.api.deps import GraphDep, ReadyRepoDep, SessionDep
from archon.context.index import index_repository
from archon.db.models import ChatMessage, Conversation, Document, Repository, ToolRun
from archon.services import chat as chat_service
from archon.services import docs as docs_service
from archon.services import reasoning

router = APIRouter(prefix="/repos/{repo_id}", tags=["intelligence"])


# ---------------------------------------------------------------- retrieval index
@router.post("/index")
async def build_index(
    repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, embeddings: bool | None = None
) -> dict[str, Any]:
    return await index_repository(session, AnalysisContext(repo, rg), with_embeddings=embeddings)


@router.get("/index/status")
async def index_status(repo: ReadyRepoDep) -> dict[str, Any]:
    from archon.context import embedder

    return {"pending": await embedder.pending_count(repo.id), **embedder.progress(repo.id)}


# ---------------------------------------------------------------- chat
class ChatRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=4000)
    conversation_id: str | None = None


@router.post("/chat")
async def chat(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: ChatRequest) -> dict[str, Any]:
    return await chat_service.ask(session, rg, repo, body.question, body.conversation_id)


@router.post("/chat/stream")
async def chat_stream(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: ChatRequest) -> StreamingResponse:
    """The chat answer as newline-delimited JSON events, written as the model produces it (D-034)."""
    events = await chat_service.ask_stream(session, rg, repo, body.question, body.conversation_id)

    async def lines() -> AsyncIterator[bytes]:
        async for ev in events:
            yield (json.dumps(jsonable_encoder(ev)) + "\n").encode()

    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache"})


@router.get("/conversations")
async def conversations(repo: ReadyRepoDep, session: SessionDep) -> list[dict[str, Any]]:
    rows = (
        await session.execute(
            select(Conversation)
            .where(Conversation.repo_id == repo.id)
            .order_by(Conversation.created_at.desc())
            .limit(50)
        )
    ).scalars()
    return [{"id": c.id, "title": c.title, "created_at": c.created_at} for c in rows]


@router.get("/conversations/{conversation_id}")
async def conversation(repo: ReadyRepoDep, session: SessionDep, conversation_id: str) -> dict[str, Any]:
    conv = await session.get(Conversation, conversation_id)
    if conv is None or conv.repo_id != repo.id:
        raise HTTPException(404, "conversation not found")
    msgs = (
        await session.execute(
            select(ChatMessage).where(ChatMessage.conversation_id == conv.id).order_by(ChatMessage.created_at)
        )
    ).scalars()
    return {
        "id": conv.id,
        "title": conv.title,
        "messages": [
            {"id": m.id, "role": m.role, "content": m.content, "sources": m.sources, "created_at": m.created_at}
            for m in msgs
        ],
    }


# ---------------------------------------------------------------- docs
class DocsRequest(BaseModel):
    kinds: list[str] | None = None


def _doc_out(d: Document, with_content: bool = True) -> dict[str, Any]:
    out = {"id": d.id, "kind": d.kind, "title": d.title, "subject": d.subject, "ai": d.ai, "created_at": d.created_at}
    if with_content:
        out["content"] = d.content
    return out


@router.post("/docs/generate")
async def generate_docs(
    repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: DocsRequest | None = None
) -> list[dict[str, Any]]:
    kinds = body.kinds if body and body.kinds else docs_service.KINDS
    unknown = [k for k in kinds if k not in docs_service.KINDS]
    if unknown:
        raise HTTPException(400, f"unknown doc kinds: {unknown}; valid: {docs_service.KINDS}")
    docs = await docs_service.generate(session, repo, AnalysisContext(repo, rg), kinds)
    return [_doc_out(d, with_content=False) for d in docs]


@router.get("/docs")
async def list_docs(repo: ReadyRepoDep, session: SessionDep) -> list[dict[str, Any]]:
    return [_doc_out(d, with_content=False) for d in await docs_service.list_documents(session, repo.id)]


@router.get("/docs/{doc_id}")
async def get_doc(repo: ReadyRepoDep, session: SessionDep, doc_id: str) -> dict[str, Any]:
    d = await session.get(Document, doc_id)
    if d is None or d.repo_id != repo.id:
        raise HTTPException(404, "document not found")
    return _doc_out(d)


# ---------------------------------------------------------------- reasoning workflows
class DebugRequest(BaseModel):
    error: str = Field(..., min_length=3, max_length=40000)
    description: str = ""


class ImpactRequest(BaseModel):
    node_id: str | None = None
    path: str | None = None
    symbol: str | None = None
    depth: int = Field(3, ge=1, le=6)
    change: str = ""
    ai: bool = True


class FeatureRequest(BaseModel):
    description: str = Field(..., min_length=5, max_length=8000)


class AdviseRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=4000)


class RefactorRequest(BaseModel):
    node_id: str | None = None
    path: str | None = None


class TestGenRequest(BaseModel):
    node_id: str


class ReviewRequest(BaseModel):
    diff: str = Field(..., min_length=10, max_length=400000)
    title: str = ""


class LogsRequest(BaseModel):
    logs: str = Field(..., min_length=3, max_length=2_000_000)
    description: str = ""


# ---------------------------------------------------------------- tool history (decisions.md D-034)
MAX_INPUT_CHARS = 20000
KEEP_RUNS_PER_TOOL = 30


def _title(text: str) -> str:
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    return line[:120]


async def _saved(
    session: SessionDep, repo: Repository, tool: str, title: str, inputs: dict[str, Any], out: dict[str, Any]
) -> dict[str, Any]:
    """Store the run (inputs trimmed) and return the result with its run id; keep the newest runs per tool."""
    target = out.get("target") if isinstance(out.get("target"), dict) else None
    trimmed = {k: v[:MAX_INPUT_CHARS] if isinstance(v, str) else v for k, v in inputs.items()}
    out = jsonable_encoder(out)  # the JSON column needs plain values (datetimes, sets…)
    run = ToolRun(
        repo_id=repo.id, tool=tool, title=title or (target or {}).get("name", "") or tool, inputs=trimmed, result=out
    )
    session.add(run)
    await session.flush()
    old = (
        select(ToolRun.id)
        .where(ToolRun.repo_id == repo.id, ToolRun.tool == tool)
        .order_by(ToolRun.created_at.desc())
        .offset(KEEP_RUNS_PER_TOOL)
    )
    await session.execute(delete(ToolRun).where(ToolRun.id.in_(old)))
    await session.commit()
    return {**out, "run_id": run.id}


@router.get("/tool-runs")
async def tool_runs(repo: ReadyRepoDep, session: SessionDep, tool: str | None = None) -> list[dict[str, Any]]:
    q = select(ToolRun.id, ToolRun.tool, ToolRun.title, ToolRun.created_at).where(ToolRun.repo_id == repo.id)
    if tool:
        q = q.where(ToolRun.tool == tool)
    rows = await session.execute(q.order_by(ToolRun.created_at.desc()).limit(50))
    return [{"id": i, "tool": t, "title": ti, "created_at": c} for i, t, ti, c in rows]


@router.get("/tool-runs/{run_id}")
async def tool_run(repo: ReadyRepoDep, session: SessionDep, run_id: str) -> dict[str, Any]:
    r = await session.get(ToolRun, run_id)
    if r is None or r.repo_id != repo.id:
        raise HTTPException(404, "run not found")
    return {
        "id": r.id,
        "tool": r.tool,
        "title": r.title,
        "inputs": r.inputs,
        "result": r.result,
        "created_at": r.created_at,
    }


@router.delete("/tool-runs/{run_id}", status_code=204)
async def delete_tool_run(repo: ReadyRepoDep, session: SessionDep, run_id: str) -> None:
    r = await session.get(ToolRun, run_id)
    if r is None or r.repo_id != repo.id:
        raise HTTPException(404, "run not found")
    await session.delete(r)
    await session.commit()


@router.post("/debug")
async def debug(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: DebugRequest) -> dict[str, Any]:
    out = await reasoning.debug(session, AnalysisContext(repo, rg), body.error, body.description)
    return await _saved(session, repo, "debug", _title(body.error), body.model_dump(), out)


@router.post("/impact")
async def impact(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: ImpactRequest) -> dict[str, Any]:
    if not (body.node_id or body.path or body.symbol):
        raise HTTPException(400, "provide node_id, path or symbol")
    out = await reasoning.impact(
        session, AnalysisContext(repo, rg), body.node_id, body.path, body.symbol, body.depth, body.change, body.ai
    )
    if "error" in out:
        raise HTTPException(404, out["error"])
    return await _saved(session, repo, "impact", body.change[:120], body.model_dump(), out)


@router.post("/feature")
async def feature(
    repo: ReadyRepoDep,
    rg: GraphDep,
    session: SessionDep,
    body: FeatureRequest,
    mode: str = Query("simulate", pattern="^(simulate|plan)$"),
) -> dict[str, Any]:
    out = await reasoning.plan_feature(session, AnalysisContext(repo, rg), body.description, mode=mode)
    tool = "plan" if mode == "plan" else "feature"
    return await _saved(session, repo, tool, _title(body.description), body.model_dump(), out)


@router.post("/plan")
async def plan(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: FeatureRequest) -> dict[str, Any]:
    out = await reasoning.plan_feature(session, AnalysisContext(repo, rg), body.description, mode="plan")
    return await _saved(session, repo, "plan", _title(body.description), body.model_dump(), out)


@router.post("/advise")
async def advise(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: AdviseRequest) -> dict[str, Any]:
    out = await reasoning.advise(session, AnalysisContext(repo, rg), body.question)
    return await _saved(session, repo, "advise", _title(body.question), body.model_dump(), out)


@router.post("/refactor")
async def refactor(
    repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: RefactorRequest | None = None
) -> dict[str, Any]:
    out = await reasoning.refactor(
        session, AnalysisContext(repo, rg), body.node_id if body else None, body.path if body else None
    )
    if "error" in out:
        raise HTTPException(404, out["error"])
    return await _saved(session, repo, "refactor", "", body.model_dump() if body else {}, out)


@router.post("/tests/generate")
async def generate_tests(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: TestGenRequest) -> dict[str, Any]:
    out = await reasoning.generate_tests(session, AnalysisContext(repo, rg), body.node_id)
    if "error" in out:
        raise HTTPException(404, out["error"])
    return await _saved(session, repo, "tests", "", body.model_dump(), out)


@router.post("/review")
async def review(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: ReviewRequest) -> dict[str, Any]:
    out = await reasoning.review(session, AnalysisContext(repo, rg), body.diff, body.title)
    if "error" in out:
        raise HTTPException(400, out["error"])
    return await _saved(session, repo, "review", body.title or _title(body.diff), body.model_dump(), out)


@router.post("/logs")
async def logs(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, body: LogsRequest) -> dict[str, Any]:
    out = await reasoning.incident(session, AnalysisContext(repo, rg), body.logs, body.description)
    return await _saved(session, repo, "logs", body.description[:120] or _title(body.logs), body.model_dump(), out)
