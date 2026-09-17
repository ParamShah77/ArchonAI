"""Run analyzers, persist findings, compute health (flow.md §3.6)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from archon.analysis import api_intel, db_intel, dependency, tests_intel
from archon.analysis.base import AnalysisContext, Analyzer
from archon.analysis.debt import DebtAnalyzer
from archon.analysis.findings import Finding, sort_findings
from archon.analysis.health import compute_health
from archon.analysis.performance import PerformanceAnalyzer
from archon.analysis.security import SecurityAnalyzer
from archon.db.models import AnalysisRun, FindingRow, HealthSnapshot, Repository
from archon.db.session import session_factory
from archon.graph.query import graph_cache

log = logging.getLogger("archon.analysis")

ANALYZERS: dict[str, Analyzer] = {
    a.name: a
    for a in (
        SecurityAnalyzer(),
        PerformanceAnalyzer(),
        DebtAnalyzer(),
        dependency.DependencyAnalyzer(),
        api_intel.ApiAnalyzer(),
        db_intel.DatabaseAnalyzer(),
        tests_intel.TestAnalyzer(),
    )
}
REPORT_BUILDERS = {
    "api": api_intel.build_report,
    "database": db_intel.build_report,
    "dependency": dependency.build_report,
    "tests": tests_intel.build_report,
}


async def save_findings(session: AsyncSession, repo_id: str, analyzer: str, findings: list[Finding]) -> int:
    existing = {
        r.fingerprint: r
        for r in (
            await session.execute(
                select(FindingRow).where(FindingRow.repo_id == repo_id, FindingRow.analyzer == analyzer)
            )
        ).scalars()
    }
    keep_status = {fp: r.status for fp, r in existing.items() if r.status != "open"}
    await session.execute(delete(FindingRow).where(FindingRow.repo_id == repo_id, FindingRow.analyzer == analyzer))
    rows = []
    for f in sort_findings(findings):
        d = f.to_dict()
        rows.append(FindingRow(repo_id=repo_id, status=keep_status.get(d["fingerprint"], "open"), **d))
    session.add_all(rows)
    return len(rows)


async def run_analyzers(session: AsyncSession, repo: Repository, names: list[str]) -> dict[str, Any]:
    rg = await graph_cache.get(session, repo.id)
    ctx = AnalysisContext(repo, rg)
    summary: dict[str, Any] = {}
    for name in names:
        analyzer = ANALYZERS.get(name)
        if analyzer is None:
            summary[name] = {"error": "unknown analyzer"}
            continue
        try:
            findings = await analyzer.run(ctx)
            n = await save_findings(session, repo.id, name, findings)
            summary[name] = {"findings": n}
        except Exception as e:  # noqa: BLE001 - one analyzer must not sink the batch
            log.exception("analyzer %s failed", name)
            summary[name] = {"error": f"{type(e).__name__}: {e}"}
    await session.commit()
    return summary


async def compute_and_store_health(session: AsyncSession, repo: Repository) -> dict[str, Any]:
    rg = await graph_cache.get(session, repo.id)
    ctx = AnalysisContext(repo, rg)
    rows = list((await session.execute(select(FindingRow).where(FindingRow.repo_id == repo.id))).scalars())
    findings = [
        {
            "analyzer": r.analyzer,
            "category": r.category,
            "severity": r.severity,
            "confidence": r.confidence,
            "status": r.status,
            "title": r.title,
            "path": r.path,
            "start_line": r.start_line,
            "id": r.id,
        }
        for r in rows
    ]
    reports = {"tests": tests_intel.build_report(ctx)}
    health = compute_health(ctx, findings, reports)
    session.add(HealthSnapshot(repo_id=repo.id, commit_sha=repo.commit_sha, score=health["score"], breakdown=health))
    await session.commit()
    return health


async def run_analysis_job(run_id: str) -> None:
    """Background task: execute an AnalysisRun row."""
    Session = session_factory()
    async with Session() as session:
        run = await session.get(AnalysisRun, run_id)
        if run is None:
            return
        repo = await session.get(Repository, run.repo_id)
        if repo is None:
            return
        run.status = "running"
        await session.commit()
        try:
            summary = await run_analyzers(session, repo, list(run.analyzers))
            health = await compute_and_store_health(session, repo)
            summary["health"] = {"score": health["score"], "grade": health["grade"]}
            run.summary = summary
            run.status = "done"
        except Exception as e:  # noqa: BLE001
            log.exception("analysis run failed")
            run.status = "failed"
            run.error = f"{type(e).__name__}: {e}"
        run.finished_at = datetime.now(UTC)
        await session.commit()
