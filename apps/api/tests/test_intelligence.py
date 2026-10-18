"""Phase 2-4: analyzers, retrieval, chat, docs, and reasoning workflows — all with the mock LLM provider."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from archon.analysis import codeshape
from archon.graph.model import Node, NodeKind
from archon.services import stacktrace
from archon.services.reasoning import analyze_logs, parse_diff


@pytest.fixture
async def client():
    os.environ["ARCHON_LLM_PROVIDER"] = "mock"
    from archon.config import get_settings
    from archon.llm.registry import reset as reset_llm

    get_settings.cache_clear()
    reset_llm()
    from archon.main import create_app

    app = create_app()
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c
    os.environ["ARCHON_LLM_PROVIDER"] = "gemini"
    get_settings.cache_clear()
    reset_llm()


async def _ready_repo(client: AsyncClient, source: str) -> str:
    r = await client.post("/repos", json={"source": source})
    rid = r.json()["id"]
    for _ in range(100):
        repo = (await client.get(f"/repos/{rid}")).json()
        if repo["status"] in ("ready", "failed"):
            break
        await asyncio.sleep(0.1)
    assert repo["status"] == "ready", repo.get("error")
    return rid


# ------------------------------------------------------------------ unit: code shape
def test_codeshape_detects_query_in_loop_and_nesting():
    src = """def f(items):
    out = []
    for i in items:
        row = db.execute("SELECT * FROM t WHERE id = ?", i)
        for j in row:
            if j:
                out.append(j)
    return out
"""
    n = Node.create(NodeKind.FUNCTION, "f", "a.py", "a.py::f", language="python", start_line=1, end_line=8)
    sh = codeshape.analyze_body(n, src)
    assert sh.queries_in_loop == [4]
    assert sh.max_loop_depth == 2
    assert sh.select_star == [4]
    assert sh.loops == 2


def test_codeshape_async_blocking():
    src = "async def g():\n    time.sleep(1)\n    r = requests.get('http://x')\n    return r\n"
    n = Node.create(
        NodeKind.FUNCTION, "g", "a.py", "a.py::g", language="python", start_line=1, end_line=4, meta={"async": True}
    )
    sh = codeshape.analyze_body(n, src)
    assert sh.sync_sleep_in_async == [2] and sh.sync_http_in_async == [3]


# ------------------------------------------------------------------ unit: stack traces, diffs, logs
def test_stacktrace_python_and_js():
    py = 'Traceback (most recent call last):\n  File "app/services/orders.py", line 9, in place_order\n    validate(order)\n  File "app/services/orders.py", line 15, in validate\n    raise ValueError("no order")\nValueError: no order\n'
    pe = stacktrace.parse(py)
    assert pe.runtime == "python" and pe.error_type == "ValueError" and pe.message == "no order"
    assert [(f.raw_path, f.line, f.func) for f in pe.frames] == [
        ("app/services/orders.py", 9, "place_order"),
        ("app/services/orders.py", 15, "validate"),
    ]
    js = "TypeError: Cannot read properties of undefined (reading 'id')\n    at UserRepo.byId (src/routes/users.ts:8:20)\n    at src/routes/users.ts:14:30\n"
    pe = stacktrace.parse(js)
    assert pe.runtime == "javascript" and pe.error_type == "TypeError"
    assert pe.frames[0].func == "UserRepo.byId" and pe.frames[0].line == 8


def test_parse_diff():
    diff = "diff --git a/app/x.py b/app/x.py\n--- a/app/x.py\n+++ b/app/x.py\n@@ -1,3 +1,4 @@\n def f():\n-    return 1\n+    print('debug')\n+    return 2\n"
    files = parse_diff(diff)
    assert files[0]["path"] == "app/x.py"
    assert [ln for ln, _ in files[0]["added"]] == [2, 3]
    assert files[0]["removed"] == ["    return 1"]


def test_analyze_logs_clusters_and_bursts():
    logs = "\n".join(
        [
            "2026-01-01T10:00:01Z INFO server started on port 8000",
            "2026-01-01T10:00:02Z INFO request id=123 took 12ms",
            "2026-01-01T10:00:03Z INFO request id=124 took 15ms",
            "2026-01-01T10:01:00Z ERROR db connection refused host=10.0.0.5",
            "2026-01-01T10:01:01Z ERROR db connection refused host=10.0.0.6",
            "2026-01-01T10:01:02Z ERROR Traceback in app/services/orders.py:9",
        ]
    )
    from archon.graph.query import RepoGraph

    rep = analyze_logs(logs, RepoGraph("x", {}, []))
    assert rep["entries"] == 6 and rep["levels"]["ERROR"] == 3
    assert rep["clusters"][0]["template"].startswith("db connection refused") and rep["clusters"][0]["count"] == 2
    assert rep["bursts"][0]["minute"] == "2026-01-01T10:01"


# ------------------------------------------------------------------ integration through the API
async def test_full_intelligence_flow(client: AsyncClient, fixture_repo: Path):
    rid = await _ready_repo(client, str(fixture_repo))

    # analyzers
    r = await client.post(f"/repos/{rid}/analyze")
    assert r.status_code == 202
    for _ in range(100):
        runs = (await client.get(f"/repos/{rid}/analysis/runs")).json()
        if runs and runs[0]["status"] in ("done", "failed"):
            break
        await asyncio.sleep(0.1)
    assert runs[0]["status"] == "done", runs[0]
    assert all("error" not in v for k, v in runs[0]["summary"].items() if k != "health"), runs[0]["summary"]
    f = (await client.get(f"/repos/{rid}/findings")).json()
    assert f["count"] > 0
    analyzers = {x["analyzer"] for x in f["findings"]}
    assert "tests" in analyzers  # fixture has no tests -> "No tests found"
    titles = " ".join(x["title"] for x in f["findings"])
    assert "No tests found" in titles
    fid = f["findings"][0]["id"]
    r = await client.patch(f"/repos/{rid}/findings/{fid}", json={"status": "dismissed"})
    assert r.json()["status"] == "dismissed"
    assert (await client.get(f"/repos/{rid}/findings")).json()["count"] == f["count"] - 1

    # health
    h = (await client.get(f"/repos/{rid}/health-score")).json()
    assert 0 <= h["current"]["score"] <= 100 and h["current"]["grade"] in "ABCDF"
    assert set(h["current"]["dimensions"]) == {
        "security",
        "performance",
        "maintainability",
        "architecture",
        "dependencies",
        "tests",
        "complexity",
    }

    # reports
    api = (await client.get(f"/repos/{rid}/api-intel")).json()
    assert api["count"] == 4
    users_get = next(e for e in api["endpoints"] if e["route"] == "/users/{user_id}")
    assert "users" in users_get["reaches_tables"] and "orders" in users_get["reaches_tables"]
    db = (await client.get(f"/repos/{rid}/db-intel")).json()
    assert {t["name"] for t in db["tables"]} == {"users", "orders"}
    assert any(r["from"] == "orders" and r["to"] == "users" for r in db["relationships"])
    deps = (await client.get(f"/repos/{rid}/dependencies")).json()
    assert {d["name"] for d in deps["inventory"]} >= {"fastapi", "express", "pg", "jest"}
    assert any(d["name"] == "sqlalchemy" for d in deps["unused"])
    ti = (await client.get(f"/repos/{rid}/tests-intel")).json()
    assert ti["test_files"] == 0 and ti["risky_untested"]

    # retrieval + chat (mock LLM)
    idx = (await client.post(f"/repos/{rid}/index")).json()
    assert idx["chunks"] > 5 and idx["embedded"] == idx["chunks"]
    c = (await client.post(f"/repos/{rid}/chat", json={"question": "How does place_order work?"})).json()
    assert c["answer"].startswith("[mock:") and c["sources"]
    assert any(s["name"] == "place_order" for s in c["sources"])
    conv = (await client.get(f"/repos/{rid}/conversations/{c['conversation_id']}")).json()
    assert [m["role"] for m in conv["messages"]] == ["user", "assistant"]

    # the same answer, streamed as NDJSON events
    import json as _json

    r = await client.post(f"/repos/{rid}/chat/stream", json={"question": "How does place_order work?"})
    events = [_json.loads(line) for line in r.text.splitlines() if line.strip()]
    assert [e["type"] for e in events][0] == "sources" and events[-1]["type"] == "done"
    text = "".join(e["text"] for e in events if e["type"] == "delta")
    assert text.startswith("[mock:")
    streamed = (await client.get(f"/repos/{rid}/conversations/{events[-1]['conversation_id']}")).json()
    assert streamed["messages"][-1]["content"] == text

    # docs
    docs = (await client.post(f"/repos/{rid}/docs/generate")).json()
    kinds = {d["kind"] for d in docs}
    assert kinds >= {"architecture", "api", "modules", "dataflow", "database", "dependencies", "setup", "onboarding"}
    api_doc = next(d for d in docs if d["kind"] == "api")
    body = (await client.get(f"/repos/{rid}/docs/{api_doc['id']}")).json()
    assert "GET /users/{user_id}" in body["content"] and body["ai"] is True

    # workflows
    err = 'Traceback (most recent call last):\n  File "app/services/orders.py", line 9, in place_order\n    validate(order)\nValueError: no order\n'
    d = (await client.post(f"/repos/{rid}/debug", json={"error": err})).json()
    assert d["facts"]["parsed"]["error_type"] == "ValueError"
    assert d["facts"]["focus"][0]["name"] == "place_order" and d["ai"]["root_cause"]
    imp = (await client.post(f"/repos/{rid}/impact", json={"symbol": "execute", "depth": 3, "ai": False})).json()
    assert imp["target"]["name"] == "execute"
    assert {r["name"] for r in imp["upstream"]["functions"]} >= {"orders_for", "place_order", "User.load"}
    assert any(e["name"] == "POST /orders" for e in imp["upstream"]["endpoints"])
    assert imp["risk"]["level"] in ("low", "medium", "high", "critical")
    feat = (
        await client.post(
            f"/repos/{rid}/feature", json={"description": "Add order cancellation endpoint that marks orders cancelled"}
        )
    ).json()
    assert feat["facts"]["relevant_code"] and feat["ai"]["mock"] is True
    plan = (await client.post(f"/repos/{rid}/plan", json={"description": "Add order cancellation"})).json()
    assert plan["ai"]
    adv = (await client.post(f"/repos/{rid}/advise", json={"question": "How to support 10x more users?"})).json()
    assert adv["ai"] and adv["facts"]["components"]
    ref = (await client.post(f"/repos/{rid}/refactor", json={})).json()
    assert ref["target"]["path"] and ref["ai"]
    node_id = imp["target"]["id"]
    tg = (await client.post(f"/repos/{rid}/tests/generate", json={"node_id": node_id})).json()
    assert tg["heuristic_cases"][0]["kind"] == "happy" and tg["ai"]
    diff = "--- a/app/services/orders.py\n+++ b/app/services/orders.py\n@@ -8,3 +8,4 @@\n def place_order(user_id):\n     order = Order()\n+    print('debug')\n     validate(order)\n"
    rv = (await client.post(f"/repos/{rid}/review", json={"diff": diff})).json()
    assert rv["files"][0]["path"] == "app/services/orders.py"
    assert any(q["rule"] == "REV-DEBUG-LEFTOVER" for q in rv["quick_findings"])
    assert any(s["name"] == "place_order" for s in rv["changed_symbols"])
    lg = (
        await client.post(
            f"/repos/{rid}/logs",
            json={
                "logs": "2026-01-01T10:00:00Z ERROR failed in app/services/orders.py:9\n2026-01-01T10:00:01Z INFO ok"
            },
        )
    ).json()
    assert lg["facts"]["code_refs"][0]["node"] == "place_order" and lg["ai"]


async def test_reindex_reuses_vectors_and_background_job_embeds_the_rest(
    client: AsyncClient, fixture_repo: Path, monkeypatch
):
    from archon.config import get_settings
    from archon.context import embedder

    rid = await _ready_repo(client, str(fixture_repo))
    first = (await client.post(f"/repos/{rid}/index")).json()
    assert first["pending"] == 0 and first["embedded"] == first["chunks"]
    # unchanged code: every vector is reused, nothing is sent to the provider again
    again = (await client.post(f"/repos/{rid}/index")).json()
    assert again["reused"] == again["chunks"] and again["pending"] == 0

    # more chunks than one minute of quota -> paced background job (sleeps skipped in the test)
    monkeypatch.setenv("ARCHON_EMBED_RPM", "5")
    get_settings.cache_clear()
    real_sleep = asyncio.sleep
    monkeypatch.setattr(embedder.asyncio, "sleep", lambda s: real_sleep(0))
    try:
        fresh = (await client.post(f"/repos/{rid}/index", params={"embeddings": "false"})).json()
        assert fresh["embedded"] == 0
        out = (await client.post(f"/repos/{rid}/index")).json()
        assert out["background"] is True and out["pending"] == out["chunks"]
        for _ in range(100):
            st = (await client.get(f"/repos/{rid}/index/status")).json()
            if not st["running"]:
                break
            await real_sleep(0.05)
        assert st["pending"] == 0 and st["embedded"] == out["chunks"]
    finally:
        monkeypatch.delenv("ARCHON_EMBED_RPM")
        get_settings.cache_clear()
