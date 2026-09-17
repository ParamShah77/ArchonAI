from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from archon.graph.model import Edge, Node


class RepoCreate(BaseModel):
    source: str = Field(..., description="Git URL (https/ssh) or absolute local path", min_length=1)


class RepoOut(BaseModel):
    id: str
    name: str
    source: str
    status: str
    error: str = ""
    default_branch: str = ""
    commit_sha: str = ""
    stats: dict[str, Any] = {}
    stack: dict[str, Any] = {}
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class NodeOut(BaseModel):
    id: str
    kind: str
    name: str
    path: str = ""
    qualified_name: str = ""
    language: str = ""
    start_line: int = 0
    end_line: int = 0
    meta: dict[str, Any] = {}

    @classmethod
    def from_node(cls, n: Node) -> NodeOut:
        return cls(
            id=n.id,
            kind=str(n.kind),
            name=n.name,
            path=n.path,
            qualified_name=n.qualified_name,
            language=n.language,
            start_line=n.start_line,
            end_line=n.end_line,
            meta=n.meta,
        )


class EdgeOut(BaseModel):
    id: str
    source: str
    target: str
    kind: str
    meta: dict[str, Any] = {}

    @classmethod
    def from_edge(cls, e: Edge) -> EdgeOut:
        return cls(id=e.id, source=e.source, target=e.target, kind=str(e.kind), meta=e.meta)


class GraphOut(BaseModel):
    level: str
    focus: str | None = None
    nodes: list[NodeOut]
    edges: list[EdgeOut]


class NeighborOut(BaseModel):
    node: NodeOut
    edge_kind: str
    direction: str  # "in" | "out"
    meta: dict[str, Any] = {}


class NodeDetailOut(BaseModel):
    node: NodeOut
    file: NodeOut | None = None
    parent: NodeOut | None = None
    source: str | None = None
    neighbors: list[NeighborOut]


class SearchOut(BaseModel):
    query: str
    results: list[NodeOut]


class SourceOut(BaseModel):
    path: str
    start_line: int
    end_line: int
    content: str
    total_lines: int


class HealthOut(BaseModel):
    status: str
    version: str
    llm_provider: str
    llm_configured: bool
    database: str
