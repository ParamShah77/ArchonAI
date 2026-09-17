"""In-memory Code Graph model (decisions.md D-005).

Nodes and edges produced by extractors are plain dataclasses; the store
persists them and `query` loads them into networkx for algorithms.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class NodeKind(StrEnum):
    REPO = "repo"
    DIRECTORY = "directory"
    FILE = "file"
    MODULE = "module"
    CLASS = "class"
    FUNCTION = "function"
    METHOD = "method"
    ENDPOINT = "endpoint"
    TABLE = "table"
    DEPENDENCY = "dependency"


class EdgeKind(StrEnum):
    CONTAINS = "contains"
    IMPORTS = "imports"
    CALLS = "calls"
    EXTENDS = "extends"
    IMPLEMENTS = "implements"
    EXPOSES = "exposes"
    QUERIES = "queries"
    DEPENDS_ON = "depends_on"


# Which node kinds appear at which zoom level of the map.
LEVEL_KINDS: dict[str, set[NodeKind]] = {
    "system": {NodeKind.REPO, NodeKind.DIRECTORY, NodeKind.DEPENDENCY},
    "file": {NodeKind.DIRECTORY, NodeKind.FILE, NodeKind.DEPENDENCY},
    "symbol": {
        NodeKind.FILE,
        NodeKind.CLASS,
        NodeKind.FUNCTION,
        NodeKind.METHOD,
        NodeKind.ENDPOINT,
        NodeKind.TABLE,
    },
}


def make_id(*parts: str) -> str:
    """Deterministic node id from its identity parts (kind, path, qualified name)."""
    raw = "\x1f".join(parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


@dataclass(slots=True)
class Node:
    id: str
    kind: NodeKind
    name: str
    path: str = ""  # repo-relative file path ("" for repo/dependency nodes)
    qualified_name: str = ""
    language: str = ""
    start_line: int = 0
    end_line: int = 0
    meta: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def create(cls, kind: NodeKind, name: str, path: str = "", qualified_name: str = "", **kw):
        qn = qualified_name or name
        # A TABLE is a logical entity: the SQL migration and the ORM model that declare "users"
        # must collapse into one node, so its id ignores the declaring file (decisions.md D-007).
        id_path = "" if kind == NodeKind.TABLE else path
        return cls(id=make_id(kind, id_path, qn), kind=kind, name=name, path=path, qualified_name=qn, **kw)


@dataclass(slots=True)
class Edge:
    source: str
    target: str
    kind: EdgeKind
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def id(self) -> str:
        return make_id(self.source, self.target, self.kind)


@dataclass(slots=True)
class FileExtraction:
    """Everything an extractor learned about one file, before cross-file resolution."""

    path: str
    language: str
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    # Unresolved references, resolved later by graph.builder
    imports: list[dict[str, Any]] = field(default_factory=list)  # {"module": str, "names": [...]}
    calls: list[dict[str, Any]] = field(default_factory=list)  # {"caller": node_id, "callee": str}
    bases: list[dict[str, Any]] = field(default_factory=list)  # {"class": node_id, "base": str}
