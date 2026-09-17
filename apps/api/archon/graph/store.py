"""Persist / load a repository graph (SQLAlchemy, dialect-agnostic)."""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from archon.db.models import GraphEdge, GraphNode
from archon.graph.builder import BuiltGraph
from archon.graph.model import Edge, EdgeKind, Node, NodeKind

_BATCH = 500


async def clear_graph(session: AsyncSession, repo_id: str) -> None:
    await session.execute(delete(GraphEdge).where(GraphEdge.repo_id == repo_id))
    await session.execute(delete(GraphNode).where(GraphNode.repo_id == repo_id))


async def save_graph(session: AsyncSession, repo_id: str, graph: BuiltGraph) -> None:
    await clear_graph(session, repo_id)
    node_rows = [
        {
            "id": n.id,
            "repo_id": repo_id,
            "kind": str(n.kind),
            "name": n.name[:512],
            "qualified_name": n.qualified_name,
            "path": n.path,
            "language": n.language,
            "start_line": n.start_line,
            "end_line": n.end_line,
            "meta": n.meta,
        }
        for n in graph.nodes.values()
    ]
    edge_rows = [
        {"id": e.id, "repo_id": repo_id, "source": e.source, "target": e.target, "kind": str(e.kind), "meta": e.meta}
        for e in graph.edges.values()
    ]
    for i in range(0, len(node_rows), _BATCH):
        await session.execute(GraphNode.__table__.insert(), node_rows[i : i + _BATCH])
    for i in range(0, len(edge_rows), _BATCH):
        await session.execute(GraphEdge.__table__.insert(), edge_rows[i : i + _BATCH])


async def load_graph(session: AsyncSession, repo_id: str) -> tuple[list[Node], list[Edge]]:
    nodes = [
        Node(
            id=r.id,
            kind=NodeKind(r.kind),
            name=r.name,
            path=r.path,
            qualified_name=r.qualified_name,
            language=r.language,
            start_line=r.start_line,
            end_line=r.end_line,
            meta=r.meta or {},
        )
        for r in (await session.execute(select(GraphNode).where(GraphNode.repo_id == repo_id))).scalars()
    ]
    edges = [
        Edge(source=r.source, target=r.target, kind=EdgeKind(r.kind), meta=r.meta or {})
        for r in (await session.execute(select(GraphEdge).where(GraphEdge.repo_id == repo_id))).scalars()
    ]
    return nodes, edges
