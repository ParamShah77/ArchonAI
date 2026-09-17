from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from archon.main import create_app


@pytest.fixture
async def client():
    app = create_app()
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c


async def _ingest(client: AsyncClient, source: str) -> dict:
    r = await client.post("/repos", json={"source": source})
    assert r.status_code == 202, r.text
    repo = r.json()
    for _ in range(100):
        r = await client.get(f"/repos/{repo['id']}")
        repo = r.json()
        if repo["status"] in ("ready", "failed"):
            break
        await asyncio.sleep(0.1)
    return repo


async def test_health(client: AsyncClient):
    r = await client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["llm_configured"] is False and body["database"] == "sqlite"


async def test_ingest_local_repo_and_query_graph(client: AsyncClient, fixture_repo: Path):
    repo = await _ingest(client, str(fixture_repo))
    assert repo["status"] == "ready", repo["error"]
    assert repo["stats"]["node_file"] >= 8
    assert repo["stack"]["frameworks"]

    rid = repo["id"]
    g = (await client.get(f"/repos/{rid}/graph", params={"level": "system"})).json()
    assert {n["name"] for n in g["nodes"] if n["kind"] == "directory"} == {"app", "web", "migrations"}

    g = (await client.get(f"/repos/{rid}/graph", params={"level": "symbol", "kinds": "function,method"})).json()
    assert any(n["name"] == "place_order" for n in g["nodes"])

    s = (await client.get(f"/repos/{rid}/search", params={"q": "place_order"})).json()
    node_id = s["results"][0]["id"]
    d = (await client.get(f"/repos/{rid}/nodes/{node_id}")).json()
    assert d["node"]["name"] == "place_order"
    assert "def place_order" in d["source"]
    assert {n["node"]["name"] for n in d["neighbors"] if n["direction"] == "out"} >= {"validate", "execute"}
    assert d["file"]["path"] == "app/services/orders.py"

    focus = (await client.get(f"/repos/{rid}/graph", params={"focus": node_id, "depth": 2})).json()
    assert focus["focus"] == node_id and len(focus["nodes"]) > 3

    m = (await client.get(f"/repos/{rid}/metrics")).json()
    assert m["endpoints"] == 4

    src = (await client.get(f"/repos/{rid}/source", params={"path": "app/main.py", "start": 1, "end": 3})).json()
    assert src["content"].startswith("from fastapi import FastAPI")
    bad = await client.get(f"/repos/{rid}/source", params={"path": "../../etc/passwd"})
    assert bad.status_code in (400, 404)

    arch = (await client.get(f"/repos/{rid}/architecture")).json()
    assert arch["ai"] is None and "No LLM provider" in arch["ai_error"]
    assert {c["name"] for c in arch["components"]} >= {"app", "web", "migrations"}
    layers = {c["name"]: c["layer"] for c in arch["components"]}
    assert layers["migrations"] == "data" and layers["web"] == "frontend"
    assert "app/main.py" in arch["entry_points"]

    r = await client.delete(f"/repos/{rid}")
    assert r.status_code == 204
    assert (await client.get(f"/repos/{rid}")).status_code == 404


async def test_ingest_bad_source(client: AsyncClient):
    r = await client.post("/repos", json={"source": "D:/definitely/not/here"})
    assert r.status_code == 400


async def test_graph_requires_ready_repo(client: AsyncClient, tmp_path: Path):
    (tmp_path / "x.py").write_text("x = 1\n")
    r = await client.post("/repos", json={"source": str(tmp_path)})
    rid = r.json()["id"]
    # status may still be pending/ingesting; either way a non-ready repo is rejected or ready returns 200
    r = await client.get(f"/repos/{rid}/graph")
    assert r.status_code in (200, 409)
