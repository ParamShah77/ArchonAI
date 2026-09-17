from __future__ import annotations

from pathlib import Path

from archon.graph.model import EdgeKind, NodeKind
from archon.graph.query import RepoGraph
from archon.services.ingest import analyze_checkout


def _graph(fixture_repo: Path):
    result = analyze_checkout(fixture_repo, "sample")
    g = result.graph
    return result, g, RepoGraph("test", dict(g.nodes), list(g.edges.values()))


def _edges(g, kind: EdgeKind):
    return [(g.nodes[e.source], g.nodes[e.target]) for e in g.edges.values() if e.kind == kind]


def test_internal_imports_resolve_to_files(fixture_repo: Path):
    _, g, _ = _graph(fixture_repo)
    pairs = {(s.path, t.path) for s, t in _edges(g, EdgeKind.IMPORTS) if t.kind == NodeKind.FILE}
    assert ("app/main.py", "app/api/users.py") in pairs
    assert ("app/api/users.py", "app/models.py") in pairs
    assert ("app/services/orders.py", "app/models.py") in pairs
    assert ("web/src/routes/users.ts", "web/src/db.ts") in pairs


def test_external_imports_resolve_to_dependencies(fixture_repo: Path):
    _, g, _ = _graph(fixture_repo)
    pairs = {(s.path, t.name) for s, t in _edges(g, EdgeKind.IMPORTS) if t.kind == NodeKind.DEPENDENCY}
    assert ("app/main.py", "fastapi") in pairs
    assert ("web/src/routes/users.ts", "express") in pairs
    assert ("web/src/db.ts", "pg") in pairs


def test_calls_resolve_across_files_but_not_to_unrelated_symbols(fixture_repo: Path):
    _, g, _ = _graph(fixture_repo)
    calls = {(s.qualified_name, t.qualified_name) for s, t in _edges(g, EdgeKind.CALLS)}
    assert ("app/main.py::create_order", "app/services/orders.py::place_order") in calls
    assert ("app/services/orders.py::place_order", "app/services/orders.py::validate") in calls
    assert ("app/services/orders.py::place_order", "app/models.py::execute") in calls
    assert ("app/api/users.py::get_user", "app/models.py::User.load") in calls
    # `res.json(...)` must not be linked to anything: `res` is not a known class
    assert not any(t.endswith(".json") for _, t in calls)


def test_inheritance_and_tables(fixture_repo: Path):
    _, g, _ = _graph(fixture_repo)
    ext = {(s.name, t.name) for s, t in _edges(g, EdgeKind.EXTENDS)}
    assert ("User", "Base") in ext and ("Order", "Base") in ext
    tables = {n.name for n in g.nodes.values() if n.kind == NodeKind.TABLE}
    assert tables == {"users", "orders"}
    queries = {(s.name, t.name) for s, t in _edges(g, EdgeKind.QUERIES)}
    assert ("orders_for", "orders") in queries
    assert ("load", "users") in queries
    assert ("orders", "users") in queries  # FK from SQL


def test_stack_and_stats(fixture_repo: Path):
    result, g, _ = _graph(fixture_repo)
    assert result.stack["primary_language"] == "Python"
    assert "FastAPI" in result.stack["frameworks"] and "Express" in result.stack["frameworks"]
    assert "PostgreSQL" in result.stack["databases"]
    assert g.stats["node_endpoint"] == 4
    assert result.parse_errors == []


def test_level_views_and_neighborhood(fixture_repo: Path):
    _, g, rg = _graph(fixture_repo)
    sys_nodes, sys_edges = rg.level_view("system")
    assert {n.name for n in sys_nodes if n.kind == NodeKind.DIRECTORY} == {"app", "web", "migrations"}
    assert all(e.meta["weight"] >= 1 for e in sys_edges)
    file_nodes, file_edges = rg.level_view("file")
    assert any(n.path == "app/main.py" for n in file_nodes)
    assert any(e.kind == EdgeKind.IMPORTS for e in file_edges)
    place_order = next(n for n in g.nodes.values() if n.name == "place_order")
    nodes, edges = rg.neighborhood(place_order.id, depth=1)
    names = {n.name for n in nodes}
    assert {"validate", "execute", "create_order", "orders.py"} <= names


def test_search_and_metrics(fixture_repo: Path):
    _, _, rg = _graph(fixture_repo)
    hits = rg.search("order")
    assert hits and hits[0].name in {"Order", "orders"}
    m = rg.metrics()
    assert m["files"] >= 8 and m["endpoints"] == 4 and m["tables"] == 2
    assert m["most_imported"][0]["path"] == "app/models.py"
