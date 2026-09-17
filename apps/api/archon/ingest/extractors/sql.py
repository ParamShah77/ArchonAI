"""Schema extraction from raw SQL and Prisma files (no tree-sitter needed)."""

from __future__ import annotations

import re

from archon.graph.model import Edge, EdgeKind, FileExtraction, Node, NodeKind

_QUOTE = "[`\"']?"
_CREATE_TABLE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"
    + _QUOTE
    + r"(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)"
    + _QUOTE
    + r"\s*\((.*?)\);",
    re.IGNORECASE | re.DOTALL,
)
_COLUMN = re.compile(r"^\s*" + _QUOTE + r"([A-Za-z_]\w*)" + _QUOTE + r"\s+([A-Za-z]+(?:\([^)]*\))?)", re.MULTILINE)
_FK = re.compile(r"REFERENCES\s+" + _QUOTE + r"([A-Za-z_]\w*)", re.IGNORECASE)
_PRISMA_MODEL = re.compile(r"^model\s+(\w+)\s*\{(.*?)^\}", re.MULTILINE | re.DOTALL)
_CONSTRAINT_WORDS = {"PRIMARY", "FOREIGN", "CONSTRAINT", "UNIQUE", "KEY", "INDEX", "CHECK"}
_PRISMA_SCALARS = {"String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Decimal", "Bytes"}


def _file_node(rel_path: str, language: str, lines: int) -> Node:
    return Node.create(
        NodeKind.FILE,
        name=rel_path.rsplit("/", 1)[-1],
        path=rel_path,
        qualified_name=rel_path,
        language=language,
        start_line=1,
        end_line=lines,
    )


def _table(fx: FileExtraction, file_node: Node, name: str, line: int, columns: list[str], refs: list[str]) -> None:
    t = Node.create(
        NodeKind.TABLE,
        name=name.lower(),
        path=fx.path,
        qualified_name=f"table:{name.lower()}",
        language=fx.language,
        start_line=line,
        end_line=line,
        meta={"columns": columns, "references": [r.lower() for r in refs]},
    )
    fx.nodes.append(t)
    fx.edges.append(Edge(file_node.id, t.id, EdgeKind.CONTAINS))
    for r in refs:
        fx.bases.append({"class": t.id, "base": f"table:{r.lower()}", "kind": "references"})


def extract_sql(rel_path: str, source: bytes) -> FileExtraction:
    text = source.decode("utf-8", errors="ignore")
    fx = FileExtraction(path=rel_path, language="sql")
    file_node = _file_node(rel_path, "sql", text.count("\n") + 1)
    fx.nodes.append(file_node)
    for m in _CREATE_TABLE.finditer(text):
        body = m.group(2)
        cols = [c.group(1) for c in _COLUMN.finditer(body) if c.group(1).upper() not in _CONSTRAINT_WORDS]
        refs = _FK.findall(body)
        line = text[: m.start()].count("\n") + 1
        _table(fx, file_node, m.group(1), line, cols, refs)
    return fx


def extract_prisma(rel_path: str, source: bytes) -> FileExtraction:
    text = source.decode("utf-8", errors="ignore")
    fx = FileExtraction(path=rel_path, language="prisma")
    file_node = _file_node(rel_path, "prisma", text.count("\n") + 1)
    fx.nodes.append(file_node)
    for m in _PRISMA_MODEL.finditer(text):
        cols: list[str] = []
        refs: list[str] = []
        for ln in m.group(2).splitlines():
            parts = ln.split()
            if len(parts) >= 2 and not parts[0].startswith(("@", "//")):
                cols.append(parts[0])
                typ = parts[1].rstrip("?[]")
                if typ[:1].isupper() and typ not in _PRISMA_SCALARS:
                    refs.append(typ)
        line = text[: m.start()].count("\n") + 1
        _table(fx, file_node, m.group(1), line, cols, refs)
    return fx
