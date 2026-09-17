from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from archon.db.models import Repository
from archon.db.session import get_session
from archon.graph.query import RepoGraph, graph_cache

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def get_repo(repo_id: str, session: SessionDep) -> Repository:
    repo = await session.get(Repository, repo_id)
    if repo is None:
        raise HTTPException(404, "repository not found")
    return repo


RepoDep = Annotated[Repository, Depends(get_repo)]


async def get_ready_repo(repo: RepoDep) -> Repository:
    if repo.status != "ready":
        raise HTTPException(409, f"repository is not ready (status={repo.status})")
    return repo


ReadyRepoDep = Annotated[Repository, Depends(get_ready_repo)]


async def get_graph(repo: ReadyRepoDep, session: SessionDep) -> RepoGraph:
    return await graph_cache.get(session, repo.id)


GraphDep = Annotated[RepoGraph, Depends(get_graph)]
