"""Shared machinery for tree-sitter based extractors."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod

from tree_sitter import Node as TSNode

from archon.graph.model import Edge, EdgeKind, FileExtraction, Node, NodeKind
from archon.ingest.parsing import line_span, node_text, parse_source

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head", "all", "route", "use"}

# SQL-ish statements inside string literals, used to build QUERIES edges.
_SQL_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+[`\"']?"
    r"([A-Za-z_][A-Za-z0-9_.]*)",
    re.IGNORECASE,
)
_SQL_HINT = re.compile(r"\b(select|insert|update|delete|create)\b", re.IGNORECASE)


def sql_tables_in(text: str) -> set[str]:
    if not _SQL_HINT.search(text):
        return set()
    return {m.group(1).split(".")[-1].lower() for m in _SQL_RE.finditer(text)}


class Extractor(ABC):
    language: str = ""

    def extract(self, rel_path: str, source: bytes) -> FileExtraction:
        tree = parse_source(self.language, source)
        fx = FileExtraction(path=rel_path, language=self.language)
        file_node = Node.create(
            NodeKind.FILE,
            name=rel_path.rsplit("/", 1)[-1],
            path=rel_path,
            qualified_name=rel_path,
            language=self.language,
            start_line=1,
            end_line=tree.root_node.end_point[0] + 1,
            meta={"module": self.module_name(rel_path)},
        )
        fx.nodes.append(file_node)
        self.visit(tree.root_node, source, fx, file_node)
        return fx

    @abstractmethod
    def module_name(self, rel_path: str) -> str: ...

    @abstractmethod
    def visit(self, root: TSNode, source: bytes, fx: FileExtraction, file_node: Node) -> None: ...

    # ---- helpers -------------------------------------------------------
    @staticmethod
    def add_symbol(
        fx: FileExtraction,
        parent: Node,
        kind: NodeKind,
        name: str,
        ts: TSNode,
        qualified: str,
        meta: dict | None = None,
    ) -> Node:
        start, end = line_span(ts)
        n = Node.create(
            kind,
            name=name,
            path=fx.path,
            qualified_name=qualified,
            language=fx.language,
            start_line=start,
            end_line=end,
            meta=meta or {},
        )
        fx.nodes.append(n)
        fx.edges.append(Edge(parent.id, n.id, EdgeKind.CONTAINS))
        return n

    @staticmethod
    def add_endpoint(fx: FileExtraction, handler: Node, method: str, route: str, ts: TSNode) -> Node:
        start, end = line_span(ts)
        label = f"{method.upper()} {route}"
        n = Node.create(
            NodeKind.ENDPOINT,
            name=label,
            path=fx.path,
            qualified_name=f"{fx.path}::{label}",
            language=fx.language,
            start_line=start,
            end_line=end,
            meta={"method": method.upper(), "route": route, "handler": handler.qualified_name},
        )
        fx.nodes.append(n)
        fx.edges.append(Edge(handler.id, n.id, EdgeKind.EXPOSES))
        return n

    @staticmethod
    def record_sql(fx: FileExtraction, owner: Node, text: str) -> None:
        for table in sql_tables_in(text):
            fx.calls.append({"caller": owner.id, "table": table})

    @staticmethod
    def string_value(ts: TSNode, source: bytes) -> str:
        raw = node_text(ts, source).strip()
        if len(raw) >= 2 and raw[0] in "\"'`" and raw[-1] == raw[0]:
            return raw[1:-1]
        return raw
