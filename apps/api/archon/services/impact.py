"""Capability 8 — change-impact analysis over the code graph."""

from __future__ import annotations

from typing import Any

import networkx as nx

from archon.analysis.base import TEST_PATH_RE
from archon.graph.model import EdgeKind, Node, NodeKind
from archon.graph.query import RepoGraph


def _dependency_graph(rg: RepoGraph) -> nx.DiGraph:
    """Edges point from dependent to dependency.

    caller->callee, importer->imported, subclass->base; an endpoint depends on its handler.
    """
    g = nx.DiGraph()
    g.add_nodes_from(rg.nodes.keys())
    for e in rg.edges:
        if e.kind in (EdgeKind.CALLS, EdgeKind.IMPORTS, EdgeKind.EXTENDS, EdgeKind.IMPLEMENTS, EdgeKind.QUERIES):
            g.add_edge(e.source, e.target)
        elif e.kind == EdgeKind.EXPOSES:
            g.add_edge(e.target, e.source)  # endpoint depends on its handler
    return g


def resolve_target(rg: RepoGraph, node_id: str | None, path: str | None, symbol: str | None) -> Node | None:
    if node_id:
        return rg.node(node_id)
    if path:
        for n in rg.nodes.values():
            if n.path == path and (
                symbol and n.name == symbol and n.kind != NodeKind.FILE or not symbol and n.kind == NodeKind.FILE
            ):
                return n
    if symbol:
        hits = rg.search(
            symbol, limit=1, kinds={NodeKind.FUNCTION, NodeKind.METHOD, NodeKind.CLASS, NodeKind.FILE, NodeKind.TABLE}
        )
        return hits[0] if hits else None
    return None


def analyze_impact(rg: RepoGraph, target: Node, depth: int = 3) -> dict[str, Any]:
    g = _dependency_graph(rg)
    # everything that (transitively) depends on the target = reverse reachability
    rev = g.reverse(copy=False)
    dist = nx.single_source_shortest_path_length(rev, target.id, cutoff=depth) if target.id in g else {target.id: 0}
    dist.pop(target.id, None)
    # what the target itself depends on (downstream), 1-2 hops: useful for "what could this change break internally"
    down = nx.single_source_shortest_path_length(g, target.id, cutoff=2) if target.id in g else {}
    down.pop(target.id, None)

    def bucket(ids: dict[str, int]) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {
            "functions": [],
            "files": [],
            "endpoints": [],
            "classes": [],
            "tables": [],
            "tests": [],
            "other": [],
        }
        for nid, d in sorted(ids.items(), key=lambda x: (x[1], x[0])):
            n = rg.node(nid)
            if n is None:
                continue
            row = {
                "id": n.id,
                "name": n.qualified_name.split("::")[-1],
                "kind": str(n.kind),
                "path": n.path,
                "line": n.start_line,
                "distance": d,
            }
            if n.kind == NodeKind.FILE and TEST_PATH_RE.search(n.path):
                out["tests"].append(row)
            elif n.kind in (NodeKind.FUNCTION, NodeKind.METHOD):
                (out["tests"] if TEST_PATH_RE.search(n.path) else out["functions"]).append(row)
            elif n.kind == NodeKind.FILE:
                out["files"].append(row)
            elif n.kind == NodeKind.ENDPOINT:
                out["endpoints"].append(row)
            elif n.kind == NodeKind.CLASS:
                out["classes"].append(row)
            elif n.kind == NodeKind.TABLE:
                out["tables"].append(row)
            else:
                out["other"].append(row)
        return out

    upstream = bucket(dist)
    downstream = bucket(down)
    # tests: test files that import any affected file or the target's file
    affected_files = {target.path} | {r["path"] for k in ("functions", "files", "classes") for r in upstream[k]}
    for f in rg.by_kind(NodeKind.FILE):
        if TEST_PATH_RE.search(f.path):
            imports = {rg.nodes[t].path for t, d in rg.out_edges(f.id, EdgeKind.IMPORTS) if t in rg.nodes}
            if imports & affected_files and all(r["path"] != f.path for r in upstream["tests"]):
                upstream["tests"].append(
                    {"id": f.id, "name": f.name, "kind": "file", "path": f.path, "line": 1, "distance": -1}
                )
    direct_callers = len([1 for _, d in rg.in_edges(target.id) if d["kind"] in ("calls", "imports")])
    n_ep, n_fn, n_files = len(upstream["endpoints"]), len(upstream["functions"]), len(upstream["files"])
    risk = min(
        100,
        direct_callers * 6
        + n_ep * 10
        + n_fn * 2
        + n_files * 3
        + (15 if upstream["tables"] or downstream["tables"] else 0),
    )
    risk -= min(20, len(upstream["tests"]) * 4)
    risk = max(0, risk)
    level = "critical" if risk >= 75 else "high" if risk >= 50 else "medium" if risk >= 25 else "low"
    return {
        "target": {
            "id": target.id,
            "name": target.qualified_name.split("::")[-1],
            "kind": str(target.kind),
            "path": target.path,
            "line": target.start_line,
        },
        "depth": depth,
        "direct_dependents": direct_callers,
        "upstream": upstream,
        "downstream": downstream,
        "risk": {
            "score": risk,
            "level": level,
            "reasons": _reasons(direct_callers, n_ep, n_fn, n_files, upstream, downstream),
        },
        "counts": {k: len(v) for k, v in upstream.items()},
    }


def _reasons(callers: int, eps: int, fns: int, files: int, up: dict, down: dict) -> list[str]:
    r = []
    if callers:
        r.append(f"{callers} direct caller(s)/importer(s)")
    if eps:
        r.append(f"{eps} API endpoint(s) reachable from the change")
    if fns:
        r.append(f"{fns} function(s) transitively depend on it")
    if files:
        r.append(f"{files} file(s) import it")
    if up["tables"] or down["tables"]:
        r.append("touches persistent data (tables)")
    if not up["tests"]:
        r.append("no tests cover the affected files")
    else:
        r.append(f"{len(up['tests'])} test file(s)/case(s) exercise the affected code")
    return r
