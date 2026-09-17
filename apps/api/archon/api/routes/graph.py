from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from archon.api.deps import GraphDep, ReadyRepoDep, SessionDep
from archon.api.schemas import EdgeOut, GraphOut, NeighborOut, NodeDetailOut, NodeOut, SearchOut, SourceOut
from archon.graph.model import NodeKind
from archon.ingest.scanner import read_text
from archon.services.architecture import reconstruct

router = APIRouter(prefix="/repos/{repo_id}", tags=["graph"])

MAX_NODES = 1500


def _parse_kinds(kinds: str | None) -> set[NodeKind] | None:
    if not kinds:
        return None
    out: set[NodeKind] = set()
    for k in kinds.split(","):
        k = k.strip()
        if k:
            try:
                out.add(NodeKind(k))
            except ValueError as e:
                raise HTTPException(400, f"unknown node kind: {k}") from e
    return out or None


@router.get("/graph", response_model=GraphOut)
async def get_graph(
    rg: GraphDep,
    level: str = Query("file", pattern="^(system|file|symbol)$"),
    focus: str | None = None,
    depth: int = Query(1, ge=1, le=4),
    kinds: str | None = None,
    path_prefix: str | None = Query(None, description="only nodes under this repo-relative path"),
) -> GraphOut:
    if focus:
        nodes, edges = rg.neighborhood(focus, depth=depth, kinds=_parse_kinds(kinds))
    else:
        nodes, edges = rg.level_view(level)
        ks = _parse_kinds(kinds)
        if ks:
            nodes = [n for n in nodes if n.kind in ks]
        if path_prefix:
            nodes = [
                n for n in nodes if n.path.startswith(path_prefix) or n.kind in (NodeKind.REPO, NodeKind.DEPENDENCY)
            ]
        ids = {n.id for n in nodes}
        edges = [e for e in edges if e.source in ids and e.target in ids]
    if len(nodes) > MAX_NODES:
        # keep the most connected nodes so the map stays usable
        degree: dict[str, int] = {}
        for e in edges:
            degree[e.source] = degree.get(e.source, 0) + 1
            degree[e.target] = degree.get(e.target, 0) + 1
        nodes = sorted(nodes, key=lambda n: -degree.get(n.id, 0))[:MAX_NODES]
        ids = {n.id for n in nodes}
        edges = [e for e in edges if e.source in ids and e.target in ids]
    return GraphOut(
        level=level,
        focus=focus,
        nodes=[NodeOut.from_node(n) for n in nodes],
        edges=[EdgeOut.from_edge(e) for e in edges],
    )


@router.get("/nodes/{node_id}", response_model=NodeDetailOut)
async def get_node(repo: ReadyRepoDep, rg: GraphDep, node_id: str, with_source: bool = True) -> NodeDetailOut:
    n = rg.node(node_id)
    if n is None:
        raise HTTPException(404, "node not found")
    neighbors: list[NeighborOut] = []
    for t, d in rg.out_edges(node_id):
        tn = rg.node(t)
        if tn is not None:
            neighbors.append(
                NeighborOut(node=NodeOut.from_node(tn), edge_kind=d["kind"], direction="out", meta=d.get("meta", {}))
            )
    for s, d in rg.in_edges(node_id):
        sn = rg.node(s)
        if sn is not None:
            neighbors.append(
                NeighborOut(node=NodeOut.from_node(sn), edge_kind=d["kind"], direction="in", meta=d.get("meta", {}))
            )
    source = None
    if with_source and n.path and n.kind not in (NodeKind.DIRECTORY, NodeKind.REPO, NodeKind.DEPENDENCY):
        source = _read_span(repo.local_path, n.path, n.start_line, n.end_line, max_lines=400)
    parent = rg.parent(node_id)
    file_node = rg.file_of(node_id)
    return NodeDetailOut(
        node=NodeOut.from_node(n),
        file=NodeOut.from_node(file_node) if file_node else None,
        parent=NodeOut.from_node(parent) if parent else None,
        source=source,
        neighbors=neighbors,
    )


@router.get("/search", response_model=SearchOut)
async def search(
    rg: GraphDep, q: str = Query(..., min_length=1), kinds: str | None = None, limit: int = Query(30, ge=1, le=200)
) -> SearchOut:
    return SearchOut(
        query=q, results=[NodeOut.from_node(n) for n in rg.search(q, limit=limit, kinds=_parse_kinds(kinds))]
    )


@router.get("/metrics")
async def metrics(rg: GraphDep) -> dict[str, Any]:
    return rg.metrics()


@router.get("/source", response_model=SourceOut)
async def source(
    repo: ReadyRepoDep, path: str, start: int = Query(1, ge=1), end: int | None = Query(None, ge=1)
) -> SourceOut:
    root = Path(repo.local_path).resolve()
    target = (root / path).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(400, "path escapes repository")
    if not target.is_file():
        raise HTTPException(404, "file not found")
    lines = read_text(target).splitlines()
    end = min(end or len(lines), len(lines))
    return SourceOut(
        path=path, start_line=start, end_line=end, content="\n".join(lines[start - 1 : end]), total_lines=len(lines)
    )


@router.get("/architecture")
async def architecture(repo: ReadyRepoDep, rg: GraphDep, session: SessionDep, refresh: bool = False) -> dict[str, Any]:
    return await reconstruct(session, repo, rg, refresh=refresh)


def _read_span(local_path: str, rel: str, start: int, end: int, max_lines: int) -> str | None:
    try:
        lines = read_text(Path(local_path) / rel).splitlines()
    except OSError:
        return None
    start = max(start, 1)
    end = max(end, start)
    chunk = lines[start - 1 : min(end, start - 1 + max_lines)]
    text = "\n".join(chunk)
    if end - start + 1 > max_lines:
        text += f"\n… ({end - start + 1 - max_lines} more lines)"
    return text
