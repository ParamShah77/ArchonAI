"""Turn a repository graph into retrieval chunks."""

from __future__ import annotations

from dataclasses import dataclass

from archon.analysis.base import AnalysisContext
from archon.graph.model import NodeKind

MAX_CHUNK_LINES = 120
WINDOW = 80


@dataclass(slots=True)
class Chunk:
    node_id: str
    kind: str
    name: str
    path: str
    start_line: int
    end_line: int
    text: str


def build_chunks(ctx: AnalysisContext) -> list[Chunk]:
    chunks: list[Chunk] = []
    covered: dict[str, list[tuple[int, int]]] = {}
    for n in ctx.rg.by_kind(NodeKind.CLASS, NodeKind.FUNCTION, NodeKind.METHOD):
        if ctx.rg.parent(n.id) and ctx.rg.parent(n.id).kind in (NodeKind.FUNCTION, NodeKind.METHOD):
            continue  # nested function: covered by its parent
        src = ctx.source_of(n, max_lines=MAX_CHUNK_LINES)
        if not src.strip():
            continue
        if n.kind == NodeKind.CLASS and n.end_line - n.start_line > MAX_CHUNK_LINES:
            # big class: keep only its header/first lines; methods are chunked separately
            src = "\n".join(src.splitlines()[:40])
        header = f"# {n.path}:{n.start_line}-{n.end_line} {n.kind} {n.qualified_name.split('::')[-1]}"
        chunks.append(Chunk(n.id, str(n.kind), n.name, n.path, n.start_line, n.end_line, f"{header}\n{src}"))
        covered.setdefault(n.path, []).append((n.start_line, n.end_line))
    for f in ctx.rg.by_kind(NodeKind.FILE):
        lines = ctx.lines(f.path)
        if not lines:
            continue
        spans = sorted(covered.get(f.path, []))
        # windows over regions not covered by symbol chunks (module-level code, configs, SQL)
        pos = 1
        for s, e in spans + [(len(lines) + 1, len(lines) + 1)]:
            while pos < s:
                end = min(pos + WINDOW - 1, s - 1)
                body = "\n".join(lines[pos - 1 : end])
                if body.strip() and len(body.strip()) > 40:
                    chunks.append(Chunk(f.id, "file", f.name, f.path, pos, end, f"# {f.path}:{pos}-{end} file\n{body}"))
                pos = end + 1
            pos = max(pos, e + 1)
    return chunks
