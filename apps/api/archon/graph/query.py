"""In-memory graph queries over networkx (cached per repo)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import networkx as nx
from sqlalchemy.ext.asyncio import AsyncSession

from archon.graph.model import LEVEL_KINDS, Edge, EdgeKind, Node, NodeKind
from archon.graph.store import load_graph


@dataclass(slots=True)
class RepoGraph:
    repo_id: str
    nodes: dict[str, Node]
    edges: list[Edge]
    g: nx.DiGraph = field(default_factory=nx.DiGraph)

    def __post_init__(self) -> None:
        self.g.add_nodes_from(self.nodes.keys())
        for e in self.edges:
            self.g.add_edge(e.source, e.target, kind=str(e.kind), meta=e.meta)

    # ---- lookups
    def node(self, node_id: str) -> Node | None:
        return self.nodes.get(node_id)

    def by_kind(self, *kinds: NodeKind) -> list[Node]:
        ks = set(kinds)
        return [n for n in self.nodes.values() if n.kind in ks]

    def out_edges(self, node_id: str, kind: EdgeKind | None = None) -> list[tuple[str, dict[str, Any]]]:
        return [(t, d) for _, t, d in self.g.out_edges(node_id, data=True) if kind is None or d["kind"] == str(kind)]

    def in_edges(self, node_id: str, kind: EdgeKind | None = None) -> list[tuple[str, dict[str, Any]]]:
        return [(s, d) for s, _, d in self.g.in_edges(node_id, data=True) if kind is None or d["kind"] == str(kind)]

    def parent(self, node_id: str) -> Node | None:
        for s, _ in self.in_edges(node_id, EdgeKind.CONTAINS):
            return self.nodes.get(s)
        return None

    def file_of(self, node_id: str) -> Node | None:
        n = self.nodes.get(node_id)
        while n is not None and n.kind != NodeKind.FILE:
            n = self.parent(n.id)
        return n

    # ---- views
    def component_roots(self, max_depth: int = 3) -> list[Node]:
        """Directories that act as top-level components.

        A top-level directory with no files of its own (e.g. `apps/` in a monorepo, a bare `src/`)
        is transparent: its children become the components instead, up to `max_depth` levels.
        """
        repo_id = next((n.id for n in self.nodes.values() if n.kind == NodeKind.REPO), "")
        roots: list[Node] = []
        stack = [
            (t, 1)
            for t, _ in self.out_edges(repo_id, EdgeKind.CONTAINS)
            if t in self.nodes and self.nodes[t].kind == NodeKind.DIRECTORY
        ]
        while stack:
            nid, depth = stack.pop()
            children = [self.nodes[t] for t, _ in self.out_edges(nid, EdgeKind.CONTAINS) if t in self.nodes]
            subdirs = [c for c in children if c.kind == NodeKind.DIRECTORY]
            has_files = any(c.kind == NodeKind.FILE for c in children) or bool(self.nodes[nid].meta.get("manifests"))
            if not has_files and subdirs and depth < max_depth:
                stack.extend((c.id, depth + 1) for c in subdirs)
            else:
                roots.append(self.nodes[nid])
        return sorted(roots, key=lambda n: n.path)

    def level_view(self, level: str) -> tuple[list[Node], list[Edge]]:
        """Collapse the graph to the given zoom level, aggregating symbol edges to their containers."""
        kinds = LEVEL_KINDS.get(level, LEVEL_KINDS["file"])
        keep = {nid for nid, n in self.nodes.items() if n.kind in kinds}
        if level == "system":
            roots = {n.id for n in self.component_roots()}
            keep = {nid for nid in keep if self.nodes[nid].kind != NodeKind.DIRECTORY or nid in roots}
        lift = self._lift_map(keep)
        agg: dict[tuple[str, str, str], dict[str, Any]] = {}
        for e in self.edges:
            s, t = lift.get(e.source), lift.get(e.target)
            if s is None or t is None or s == t:
                continue
            key = (s, t, str(e.kind))
            if key in agg:
                agg[key]["weight"] += 1
            else:
                agg[key] = {"weight": 1}
        edges = [Edge(s, t, EdgeKind(k), {"weight": m["weight"]}) for (s, t, k), m in agg.items()]
        return [self.nodes[n] for n in keep], edges

    def _lift_map(self, keep: set[str]) -> dict[str, str]:
        """Map every node id to its nearest kept ancestor (itself if kept)."""
        lift: dict[str, str] = {}
        for nid in self.nodes:
            chain: list[str] = []
            cur: str | None = nid
            while cur is not None and cur not in keep and cur not in lift:
                chain.append(cur)
                p = self.parent(cur)
                cur = p.id if p else None
            if cur is None:
                continue  # orphan: not under any kept node at this level
            target = lift.get(cur, cur)
            for x in chain:
                lift[x] = target
            lift.setdefault(nid, target)
        return lift

    def neighborhood(
        self, focus: str, depth: int = 1, kinds: set[NodeKind] | None = None
    ) -> tuple[list[Node], list[Edge]]:
        if focus not in self.g:
            return [], []
        und = self.g.to_undirected(as_view=True)
        ids = set(nx.single_source_shortest_path_length(und, focus, cutoff=depth).keys())
        if kinds:
            ids = {i for i in ids if self.nodes[i].kind in kinds or i == focus}
        edges = [e for e in self.edges if e.source in ids and e.target in ids]
        return [self.nodes[i] for i in ids], edges

    def search(self, q: str, limit: int = 30, kinds: set[NodeKind] | None = None) -> list[Node]:
        ql = q.lower()
        scored: list[tuple[int, Node]] = []
        for n in self.nodes.values():
            if kinds and n.kind not in kinds:
                continue
            name, qn = n.name.lower(), n.qualified_name.lower()
            if name == ql:
                score = 0
            elif name.startswith(ql):
                score = 1
            elif ql in name:
                score = 2
            elif ql in qn or ql in n.path.lower():
                score = 3
            else:
                continue
            scored.append((score, n))
        scored.sort(key=lambda x: (x[0], len(x[1].name), x[1].qualified_name))
        return [n for _, n in scored[:limit]]

    def metrics(self) -> dict[str, Any]:
        """Cheap structural metrics used by architecture reconstruction and health scoring."""
        files = self.by_kind(NodeKind.FILE)
        fan_in = {f.id: len([1 for _, d in self.in_edges(f.id, EdgeKind.IMPORTS)]) for f in files}
        fan_out = {f.id: len([1 for _, d in self.out_edges(f.id, EdgeKind.IMPORTS)]) for f in files}
        top_in = sorted(files, key=lambda f: -fan_in[f.id])[:10]
        top_out = sorted(files, key=lambda f: -fan_out[f.id])[:10]
        import_graph = nx.DiGraph()
        import_graph.add_nodes_from(f.id for f in files)
        import_graph.add_edges_from(
            (e.source, e.target) for e in self.edges if e.kind == EdgeKind.IMPORTS and e.target in fan_in
        )
        cycles = []
        try:
            for cyc in nx.simple_cycles(import_graph):
                cycles.append([self.nodes[i].path for i in cyc])
                if len(cycles) >= 20:
                    break
        except nx.NetworkXError:
            pass
        return {
            "files": len(files),
            "functions": len(self.by_kind(NodeKind.FUNCTION, NodeKind.METHOD)),
            "classes": len(self.by_kind(NodeKind.CLASS)),
            "endpoints": len(self.by_kind(NodeKind.ENDPOINT)),
            "tables": len(self.by_kind(NodeKind.TABLE)),
            "dependencies": len(self.by_kind(NodeKind.DEPENDENCY)),
            "most_imported": [{"path": f.path, "fan_in": fan_in[f.id]} for f in top_in if fan_in[f.id]],
            "most_importing": [{"path": f.path, "fan_out": fan_out[f.id]} for f in top_out if fan_out[f.id]],
            "import_cycles": cycles,
        }


class GraphCache:
    def __init__(self) -> None:
        self._graphs: dict[str, RepoGraph] = {}
        self._lock = asyncio.Lock()

    async def get(self, session: AsyncSession, repo_id: str) -> RepoGraph:
        rg = self._graphs.get(repo_id)
        if rg is not None:
            return rg
        async with self._lock:
            rg = self._graphs.get(repo_id)
            if rg is None:
                nodes, edges = await load_graph(session, repo_id)
                rg = RepoGraph(repo_id, {n.id: n for n in nodes}, edges)
                self._graphs[repo_id] = rg
            return rg

    def invalidate(self, repo_id: str) -> None:
        self._graphs.pop(repo_id, None)


graph_cache = GraphCache()
