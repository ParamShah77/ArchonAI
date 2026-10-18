"""Capability 3 — context-aware codebase chat (flow.md §3.5)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from archon.context.index import graph_facts, retrieve
from archon.db.models import ChatMessage, Conversation, Repository
from archon.db.session import end_read, session_factory
from archon.graph.model import NodeKind
from archon.graph.query import RepoGraph
from archon.llm import LLMError, Message, complete, llm_available, stream
from archon.llm.chain import last_answered_by

SYSTEM = (
    "You are ARCHON, an engineering intelligence assistant with access to a code graph and source excerpts "
    "of ONE repository. Answer strictly from the provided context. When you reference code, cite it as "
    "[path:start-end]. If the context is insufficient, say what is missing and suggest where to look "
    "(file names from the context). Be precise and concise; prefer bullet points for multi-part answers."
)
MAX_CONTEXT_CHARS = 24_000


def _mentioned_nodes(rg: RepoGraph, question: str) -> list[str]:
    ids: list[str] = []
    for hit in rg.search(
        question, limit=5, kinds={NodeKind.FUNCTION, NodeKind.METHOD, NodeKind.CLASS, NodeKind.ENDPOINT, NodeKind.TABLE}
    ):
        if hit.name.lower() in question.lower():
            ids.append(hit.id)
    return ids


async def build_context(
    session: AsyncSession, rg: RepoGraph, repo: Repository, question: str, k: int = 10
) -> tuple[str, list[dict[str, Any]]]:
    hits = await retrieve(session, rg, repo.id, question, k=k)
    sources: list[dict[str, Any]] = []
    parts: list[str] = []
    used = 0
    for h in hits:
        block = h.chunk.text
        if used + len(block) > MAX_CONTEXT_CHARS:
            block = block[: max(0, MAX_CONTEXT_CHARS - used)]
        if not block:
            break
        used += len(block)
        parts.append(block)
        sources.append(
            {
                "path": h.chunk.path,
                "start_line": h.chunk.start_line,
                "end_line": h.chunk.end_line,
                "node_id": h.chunk.node_id,
                "kind": h.chunk.kind,
                "name": h.chunk.name,
                "why": h.why,
                "score": round(h.score, 4),
            }
        )
    facts = graph_facts(rg, _mentioned_nodes(rg, question) + [s["node_id"] for s in sources if s["node_id"]])
    stack = repo.stack or {}
    header = (
        f"Repository: {repo.name}\n"
        f"Primary language: {stack.get('primary_language')}; frameworks: {stack.get('frameworks')}; "
        f"databases: {stack.get('databases')}\n"
    )
    if facts:
        header += "Graph facts:\n- " + "\n- ".join(facts) + "\n"
    context = header + "\nSource excerpts:\n\n" + "\n\n".join(parts)
    return context, sources


async def _history(session: AsyncSession, conv: Conversation | None) -> list[Message]:
    if conv is None:
        return []
    rows = list(
        (
            await session.execute(
                select(ChatMessage).where(ChatMessage.conversation_id == conv.id).order_by(ChatMessage.created_at)
            )
        ).scalars()
    )
    return [Message(m.role, m.content) for m in rows[-8:]]


async def ask(
    session: AsyncSession, rg: RepoGraph, repo: Repository, question: str, conversation_id: str | None
) -> dict[str, Any]:
    conv = await session.get(Conversation, conversation_id) if conversation_id else None
    history = await _history(session, conv)
    context, sources = await build_context(session, rg, repo, question)
    await end_read(session)  # reads done; nothing is written until the LLM has answered (D-019)
    answered_by = ""
    if llm_available():
        try:
            prompt = f"{context}\n\nQuestion: {question}"
            answer = await complete(prompt, system=SYSTEM, history=history, max_tokens=2048)
            answered_by = last_answered_by.get()
        except LLMError as e:
            answer = f"LLM error: {e}"
    else:
        answer = (
            "No LLM provider is configured, so I cannot compose an answer. The most relevant code for your "
            "question is listed in the sources below (ranked by keyword relevance). "
            "Set GEMINI_API_KEY (or GROQ/XAI) to enable answers."
        )
    if conv is None:
        conv = Conversation(repo_id=repo.id, title=question[:120])
        session.add(conv)
        await session.flush()
    session.add(ChatMessage(conversation_id=conv.id, role="user", content=question))
    session.add(ChatMessage(conversation_id=conv.id, role="assistant", content=answer, sources=sources))
    await session.commit()
    return {"conversation_id": conv.id, "answer": answer, "sources": sources, "answered_by": answered_by}


NO_LLM = (
    "No LLM provider is configured, so I cannot compose an answer. The most relevant code for your "
    "question is listed in the sources below (ranked by keyword relevance). "
    "Set GEMINI_API_KEY (or GROQ/XAI) to enable answers."
)


async def ask_stream(
    session: AsyncSession, rg: RepoGraph, repo: Repository, question: str, conversation_id: str | None
) -> AsyncIterator[dict[str, Any]]:
    """The same answer as ask(), delivered as events while it is written (decisions.md D-034).

    Events: {"type": "sources", "sources": [...]}, then {"type": "delta", "text": ...} pieces, then
    {"type": "done", "conversation_id", "answered_by"}. The reads happen here, before the response starts;
    the messages are saved with a fresh session at the end (the request's session is closed by then).
    """
    conv = await session.get(Conversation, conversation_id) if conversation_id else None
    conv_id = conv.id if conv else None
    history = await _history(session, conv)
    context, sources = await build_context(session, rg, repo, question)
    await end_read(session)
    repo_id = repo.id

    async def events() -> AsyncIterator[dict[str, Any]]:
        yield {"type": "sources", "sources": sources}
        parts: list[str] = []
        answered_by = ""
        if llm_available():
            try:
                async for piece in stream(
                    f"{context}\n\nQuestion: {question}", system=SYSTEM, history=history, max_tokens=2048
                ):
                    parts.append(piece)
                    yield {"type": "delta", "text": piece}
                answered_by = last_answered_by.get()
            except LLMError as e:
                note = f"LLM error: {e}" if not parts else f"\n\n_(the answer was cut off: {e})_"
                parts.append(note)
                yield {"type": "delta", "text": note}
            except Exception as e:  # noqa: BLE001 - a provider failing mid-answer
                note = f"\n\n_(the answer was cut off: {type(e).__name__})_"
                parts.append(note)
                yield {"type": "delta", "text": note}
        else:
            parts.append(NO_LLM)
            yield {"type": "delta", "text": NO_LLM}
        answer = "".join(parts)
        async with session_factory()() as s2:
            c = await s2.get(Conversation, conv_id) if conv_id else None
            if c is None:
                c = Conversation(repo_id=repo_id, title=question[:120])
                s2.add(c)
                await s2.flush()
            s2.add(ChatMessage(conversation_id=c.id, role="user", content=question))
            s2.add(ChatMessage(conversation_id=c.id, role="assistant", content=answer, sources=sources))
            await s2.commit()
            new_id = c.id
        yield {"type": "done", "conversation_id": new_id, "answered_by": answered_by}

    return events()
