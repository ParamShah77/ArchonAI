from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException
from sqlalchemy import select

from archon.api.deps import RepoDep, SessionDep
from archon.api.schemas import RepoCreate, RepoOut
from archon.db.models import Repository
from archon.graph.query import graph_cache
from archon.ingest.workspace import is_git_url, remove_checkout
from archon.services.ingest import ingest_repository

router = APIRouter(prefix="/repos", tags=["repositories"])


@router.post("", response_model=RepoOut, status_code=202)
async def create_repo(body: RepoCreate, session: SessionDep, tasks: BackgroundTasks) -> Repository:
    source = body.source.strip()
    if not is_git_url(source):
        from pathlib import Path

        if not Path(source).expanduser().is_dir():
            raise HTTPException(400, "source must be a git URL or an existing local directory")
    repo = Repository(
        name=source.rstrip("/").split("/")[-1].removesuffix(".git") or "repo", source=source, status="pending"
    )
    session.add(repo)
    await session.commit()
    await session.refresh(repo)
    tasks.add_task(ingest_repository, repo.id)
    return repo


@router.get("", response_model=list[RepoOut])
async def list_repos(session: SessionDep) -> list[Repository]:
    return list((await session.execute(select(Repository).order_by(Repository.created_at.desc()))).scalars())


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
    tasks.add_task(ingest_repository, repo.id)
    return repo


@router.delete("/{repo_id}", status_code=204)
async def delete_repo(repo: RepoDep, session: SessionDep) -> None:
    graph_cache.invalidate(repo.id)
    if is_git_url(repo.source):
        remove_checkout(repo.id)
    await session.delete(repo)
    await session.commit()
