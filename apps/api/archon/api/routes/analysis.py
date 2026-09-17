"""Analysis endpoints: run analyzers, list findings, intelligence reports, health."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from archon.analysis import api_intel, db_intel, dependency, tests_intel
from archon.analysis.base import AnalysisContext
from archon.analysis.runner import ANALYZERS, compute_and_store_health, run_analysis_job
from archon.api.deps import GraphDep, ReadyRepoDep, SessionDep
from archon.db.models import AnalysisRun, FindingRow, HealthSnapshot

router = APIRouter(prefix="/repos/{repo_id}", tags=["analysis"])


class AnalyzeRequest(BaseModel):
    analyzers: list[str] | None = None


class FindingStatus(BaseModel):
    status: str  # open | resolved | dismissed


def _run_out(r: AnalysisRun) -> dict[str, Any]:
    return {
        "id": r.id,
        "repo_id": r.repo_id,
        "analyzers": r.analyzers,
        "status": r.status,
        "error": r.error,
        "summary": r.summary,
        "started_at": r.started_at,
        "finished_at": r.finished_at,
    }


@router.get("/analyzers")
async def list_analyzers() -> list[dict[str, str]]:
    return [{"name": a.name, "description": a.description} for a in ANALYZERS.values()]


@router.post("/analyze", status_code=202)
async def analyze(
    repo: ReadyRepoDep, session: SessionDep, tasks: BackgroundTasks, body: AnalyzeRequest | None = None
) -> dict[str, Any]:
    names = body.analyzers if body and body.analyzers else list(ANALYZERS)
    unknown = [n for n in names if n not in ANALYZERS]
    if unknown:
        raise HTTPException(400, f"unknown analyzers: {unknown}")
    run = AnalysisRun(repo_id=repo.id, analyzers=names, status="pending")
    session.add(run)
    await session.commit()
    await session.refresh(run)
    tasks.add_task(run_analysis_job, run.id)
    return _run_out(run)


@router.get("/analysis/runs")
async def runs(repo: ReadyRepoDep, session: SessionDep) -> list[dict[str, Any]]:
    rows = (
        await session.execute(
            select(AnalysisRun).where(AnalysisRun.repo_id == repo.id).order_by(AnalysisRun.started_at.desc()).limit(20)
        )
    ).scalars()
    return [_run_out(r) for r in rows]


@router.get("/findings")
async def findings(
    repo: ReadyRepoDep,
    session: SessionDep,
    analyzer: str | None = None,
    severity: str | None = None,
    status: str = "open",
    path: str | None = None,
    limit: int = Query(500, le=2000),
) -> dict[str, Any]:
    q = select(FindingRow).where(FindingRow.repo_id == repo.id)
    if status != "all":
        q = q.where(FindingRow.status == status)
    if analyzer:
        q = q.where(FindingRow.analyzer.in_(analyzer.split(",")))
    if severity:
        q = q.where(FindingRow.severity.in_(severity.split(",")))
    if path:
        q = q.where(FindingRow.path.startswith(path))
    rows = list((await session.execute(q.limit(limit))).scalars())
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
    rows.sort(key=lambda r: (order.get(r.severity, 9), -r.confidence, r.path, r.start_line))
    counts = (
        await session.execute(
            select(FindingRow.analyzer, FindingRow.severity, func.count())
            .where(FindingRow.repo_id == repo.id, FindingRow.status == "open")
            .group_by(FindingRow.analyzer, FindingRow.severity)
        )
    ).all()
    summary: dict[str, dict[str, int]] = {}
    for a, s, c in counts:
        summary.setdefault(a, {})[s] = c
    return {"count": len(rows), "summary": summary, "findings": [_finding_out(r) for r in rows]}


def _finding_out(r: FindingRow) -> dict[str, Any]:
    return {
        k: getattr(r, k)
        for k in (
            "id",
            "analyzer",
            "category",
            "severity",
            "title",
            "description",
            "path",
            "start_line",
            "end_line",
            "node_id",
            "evidence",
            "recommendation",
            "confidence",
            "tags",
            "status",
            "created_at",
        )
    }


@router.patch("/findings/{finding_id}")
async def set_finding_status(
    repo: ReadyRepoDep, session: SessionDep, finding_id: str, body: FindingStatus
) -> dict[str, Any]:
    row = await session.get(FindingRow, finding_id)
    if row is None or row.repo_id != repo.id:
        raise HTTPException(404, "finding not found")
    if body.status not in ("open", "resolved", "dismissed"):
        raise HTTPException(400, "invalid status")
    row.status = body.status
    await session.commit()
    return _finding_out(row)


@router.get("/health-score")
async def health_score(repo: ReadyRepoDep, session: SessionDep, recompute: bool = False) -> dict[str, Any]:
    if recompute:
        await compute_and_store_health(session, repo)
    rows = list(
        (
            await session.execute(
                select(HealthSnapshot)
                .where(HealthSnapshot.repo_id == repo.id)
                .order_by(HealthSnapshot.created_at.desc())
                .limit(30)
            )
        ).scalars()
    )
    if not rows:
        current = await compute_and_store_health(session, repo)
        return {
            "current": current,
            "history": [{"score": current["score"], "created_at": None, "commit_sha": repo.commit_sha}],
        }
    return {
        "current": rows[0].breakdown,
        "history": [
            {
                "score": r.score,
                "created_at": r.created_at,
                "commit_sha": r.commit_sha,
                "dimensions": r.breakdown.get("dimensions", {}),
            }
            for r in reversed(rows)
        ],
    }


@router.get("/api-intel")
async def api_intelligence(repo: ReadyRepoDep, rg: GraphDep) -> dict[str, Any]:
    return api_intel.build_report(AnalysisContext(repo, rg))


@router.get("/db-intel")
async def db_intelligence(repo: ReadyRepoDep, rg: GraphDep) -> dict[str, Any]:
    return db_intel.build_report(AnalysisContext(repo, rg))


@router.get("/dependencies")
async def dependencies(repo: ReadyRepoDep, rg: GraphDep) -> dict[str, Any]:
    return dependency.build_report(AnalysisContext(repo, rg))


@router.get("/tests-intel")
async def tests_intelligence(repo: ReadyRepoDep, rg: GraphDep) -> dict[str, Any]:
    return tests_intel.build_report(AnalysisContext(repo, rg))
