from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from sqlalchemy import func, select

from archon.api.deps import RepoDep, SessionDep
from archon.api.schemas import RepoCreate, RepoOut, RepoSummary
from archon.db.models import AnalysisRun, Conversation, FindingRow, HealthSnapshot, Repository
from archon.graph.query import graph_cache
from archon.ingest.freshness import remote_head, tree_fingerprint
from archon.ingest.workspace import is_git_url, remove_checkout, source_key
from archon.services.ingest import ingest_repository

router = APIRouter(prefix="/repos", tags=["repositories"])


@router.post("", response_model=RepoOut, status_code=202)
async def create_repo(body: RepoCreate, session: SessionDep, tasks: BackgroundTasks) -> Repository:
    source = body.source.strip()
    if not is_git_url(source):
        if not Path(source).expanduser().is_dir():
            raise HTTPException(400, "source must be a git URL or an existing local directory")
    # the same repository added again (any spelling) refreshes the existing entry instead of duplicating it,
    # so its chats, docs and findings history stay together
    key = source_key(source)
    for existing in (await session.execute(select(Repository))).scalars():
        if source_key(existing.source) == key:
            if existing.status not in ("pending", "ingesting"):
                existing.status = "pending"
                await session.commit()
                graph_cache.invalidate(existing.id)
                _fresh_cache.pop(existing.id, None)
                tasks.add_task(ingest_repository, existing.id)
            return existing
    repo = Repository(
        name=source.rstrip("/\\").replace("\\", "/").split("/")[-1].removesuffix(".git") or "repo",
        source=source,
        status="pending",
    )
    session.add(repo)
    await session.commit()
    await session.refresh(repo)
    tasks.add_task(ingest_repository, repo.id)
    return repo


@router.get("", response_model=list[RepoOut])
async def list_repos(session: SessionDep) -> list[RepoOut]:
    repos = list((await session.execute(select(Repository))).scalars())
    summaries = await _summaries(session)
    out: list[tuple[datetime, RepoOut]] = []
    for r in repos:
        item = RepoOut.model_validate(r)
        summary = summaries.get(r.id, RepoSummary())
        times = (r.updated_at, summary.last_analysis_at, summary.last_activity_at)
        summary.last_activity_at = max(_aware(d) for d in times if d)
        item.summary = summary
        out.append((summary.last_activity_at, item))
    # most recently used first
    out.sort(key=lambda t: t[0], reverse=True)
    return [item for _, item in out]


def _aware(d: datetime) -> datetime:
    """SQLite returns naive datetimes; they are stored as UTC."""
    return d if d.tzinfo else d.replace(tzinfo=UTC)


async def _summaries(session: SessionDep) -> dict[str, RepoSummary]:
    """Health, open findings and activity for every repository in a few grouped queries."""
    out: dict[str, RepoSummary] = {}

    def get(rid: str) -> RepoSummary:
        return out.setdefault(rid, RepoSummary())

    rows = await session.execute(
        select(FindingRow.repo_id, FindingRow.severity, func.count())
        .where(FindingRow.status == "open")
        .group_by(FindingRow.repo_id, FindingRow.severity)
    )
    for rid, sev, n in rows:
        s = get(rid)
        s.open_by_severity[sev] = n
        s.open_findings += n
    runs = await session.execute(
        select(AnalysisRun.repo_id, func.min(AnalysisRun.started_at), func.max(AnalysisRun.finished_at))
        .where(AnalysisRun.status == "done")
        .group_by(AnalysisRun.repo_id)
    )
    first_audit: dict[str, datetime] = {}
    for rid, first, at in runs:
        get(rid).last_analysis_at = at
        first_audit[rid] = _aware(first)
    # health scores before the first audit were computed without findings; they would fake a drop in the trend
    snaps = await session.execute(
        select(
            HealthSnapshot.repo_id, HealthSnapshot.score, HealthSnapshot.breakdown, HealthSnapshot.created_at
        ).order_by(HealthSnapshot.created_at)
    )
    for rid, score, breakdown, created in snaps:
        s = get(rid)
        s.health_score = round(score, 1)
        s.health_grade = str((breakdown or {}).get("grade", ""))
        if rid in first_audit and _aware(created) >= first_audit[rid]:
            s.health_history = [*s.health_history[-11:], round(score, 1)]
    convs = await session.execute(
        select(Conversation.repo_id, func.count(), func.max(Conversation.created_at)).group_by(Conversation.repo_id)
    )
    for rid, n, at in convs:
        s = get(rid)
        s.conversations = n
        s.last_activity_at = at
    return out


_fresh_cache: dict[str, tuple[float, dict[str, Any]]] = {}


@router.get("/freshness")
async def freshness(session: SessionDep) -> dict[str, dict[str, Any]]:
    """Which repositories changed since they were analyzed (decisions.md D-034). Cached for a minute."""
    repos = [r for r in (await session.execute(select(Repository))).scalars() if r.status == "ready"]

    def check(r: Repository) -> dict[str, Any]:
        hit = _fresh_cache.get(r.id)
        if hit and time.monotonic() - hit[0] < 60:
            return hit[1]
        if is_git_url(r.source):
            head = remote_head(r.source, r.default_branch)
            out = {"changed": None if head is None else head != r.commit_sha, "detail": "new commits on the remote"}
        else:
            root = Path(r.local_path or r.source)
            fp = (r.stats or {}).get("fingerprint")
            out = {
                "changed": None if not fp or not root.is_dir() else tree_fingerprint(root) != fp,
                "detail": "files changed in the folder",
            }
        _fresh_cache[r.id] = (time.monotonic(), out)
        return out

    results = await asyncio.gather(*(asyncio.to_thread(check, r) for r in repos))
    return {r.id: res for r, res in zip(repos, results, strict=True)}


@router.get("/{repo_id}", response_model=RepoOut)
async def get_repo(repo: RepoDep) -> Repository:
    return repo


@router.post("/{repo_id}/reingest", response_model=RepoOut, status_code=202)
async def reingest(repo: RepoDep, session: SessionDep, tasks: BackgroundTasks) -> Repository:
    if repo.status == "ingesting":
        raise HTTPException(409, "ingestion already in progress")
    repo.status = "pending"
    await session.commit()
    graph_cache.invalidate(repo.id)
    _fresh_cache.pop(repo.id, None)
    tasks.add_task(ingest_repository, repo.id)
    return repo


@router.delete("/{repo_id}", status_code=204)
async def delete_repo(repo: RepoDep, session: SessionDep) -> None:
    graph_cache.invalidate(repo.id)
    if is_git_url(repo.source):
        remove_checkout(repo.id)
    await session.delete(repo)
    await session.commit()
