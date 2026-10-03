"""Async engine/session factory. Tables are created at startup (Phase 1; Alembic in Phase 5)."""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from archon.config import get_settings
from archon.db.models import Base

_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine():
    global _engine, _session_factory
    if _engine is None:
        url = get_settings().resolved_database_url
        # SQLite: wait up to 30 s for a competing writer instead of failing immediately (decisions.md D-019).
        connect_args = {"timeout": 30} if url.startswith("sqlite") else {}
        _engine = create_async_engine(url, echo=False, future=True, connect_args=connect_args)
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def session_factory() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _session_factory is not None
    return _session_factory


async def init_db() -> None:
    engine = get_engine()
    async with engine.begin() as conn:
        if engine.dialect.name == "sqlite":
            await conn.exec_driver_sql("PRAGMA journal_mode=WAL")
            await conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        await conn.run_sync(Base.metadata.create_all)


async def dispose_db() -> None:
    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _session_factory = None


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency."""
    async with session_factory()() as session:
        yield session


async def end_read(session: AsyncSession) -> None:
    """Close the session's current transaction before a slow await (LLM call, embeddings).

    With SQLite WAL, a transaction that has read keeps its snapshot; if anyone else commits while we
    wait on the network, upgrading that transaction to a write fails with "database is locked"
    (SQLITE_BUSY_SNAPSHOT) and the busy timeout does not help. Committing here ends the snapshot.
    Call it only when nothing is pending, so it never commits half-done work (decisions.md D-019).
    """
    if session.new or session.dirty or session.deleted:
        raise RuntimeError("end_read() called with pending changes")
    await session.commit()
