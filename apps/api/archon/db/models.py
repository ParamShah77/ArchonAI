"""SQLAlchemy models. Portable across SQLite and Postgres (decisions.md D-003)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Repository(Base):
    __tablename__ = "repositories"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(Text)  # git URL or local path
    local_path: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending|ingesting|ready|failed
    error: Mapped[str] = mapped_column(Text, default="")
    default_branch: Mapped[str] = mapped_column(String(255), default="")
    commit_sha: Mapped[str] = mapped_column(String(64), default="")
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    stack: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    nodes: Mapped[list[GraphNode]] = relationship(back_populates="repo", cascade="all, delete-orphan")
    edges: Mapped[list[GraphEdge]] = relationship(back_populates="repo", cascade="all, delete-orphan")


class GraphNode(Base):
    __tablename__ = "graph_nodes"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    repo_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("repositories.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str] = mapped_column(String(32), index=True)
    name: Mapped[str] = mapped_column(String(512))
    qualified_name: Mapped[str] = mapped_column(Text, default="")
    path: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String(32), default="")
    start_line: Mapped[int] = mapped_column(Integer, default=0)
    end_line: Mapped[int] = mapped_column(Integer, default=0)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    repo: Mapped[Repository] = relationship(back_populates="nodes")

    __table_args__ = (Index("ix_graph_nodes_repo_kind", "repo_id", "kind"),)


class GraphEdge(Base):
    __tablename__ = "graph_edges"

    id: Mapped[str] = mapped_column(String(16), primary_key=True)
    repo_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("repositories.id", ondelete="CASCADE"), primary_key=True
    )
    source: Mapped[str] = mapped_column(String(16), index=True)
    target: Mapped[str] = mapped_column(String(16), index=True)
    kind: Mapped[str] = mapped_column(String(32), index=True)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    repo: Mapped[Repository] = relationship(back_populates="edges")

    __table_args__ = (Index("ix_graph_edges_repo_kind", "repo_id", "kind"),)


class ArchitectureReport(Base):
    """Cached output of architecture reconstruction (capability 1)."""

    __tablename__ = "architecture_reports"

    repo_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("repositories.id", ondelete="CASCADE"), primary_key=True
    )
    report: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
