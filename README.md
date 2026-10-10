# ARCHON — AI Engineering Intelligence Platform

ARCHON understands, analyzes, and reasons about software systems end-to-end. It builds a
**Code Graph** of a repository (files, classes, functions, endpoints, tables, dependencies and the
relationships between them) and layers analysis and AI reasoning on top of it.

## Capabilities

All 20 capabilities from the product vision are implemented (structural analysis always; AI narratives when an LLM key is set):

| Area | What you get | Where |
|---|---|---|
| Code graph & map | tree-sitter extractors (Python, JS/TS, Go, Java, SQL, Prisma), cross-file import/call/inheritance resolution, interactive Cytoscape map (system / file / symbol levels, drill-down, search) | Overview, Code Map |
| Architecture reconstruction | components, layers, entry points, coupling, AI narrative + data flow + risks | Overview |
| Codebase chat | hybrid BM25 + embedding retrieval over graph chunks, graph facts, citations that open on the map | Chat |
| Audit | security, performance, tech-debt, dependency, API, database and test analyzers → shared Finding model; triage (resolve/dismiss); engineering health score with history | Audit |
| Intelligence reports | API inventory with auth coverage and endpoint→table reachability; database schema/relationships/access paths; dependency inventory (unused, undeclared, risky, unpinned); test coverage gaps and riskiest untested code | Intel |
| Documentation | architecture, API, per-module, data flow (mermaid), database (ER), dependencies, setup, onboarding | Docs |
| Reasoning tools | debugging/root cause from stack traces, change-impact with risk score, feature simulator, engineering planner, architecture advisor, refactoring proposals, test generation, code review of diffs, incident & log intelligence | Tools |

## Quick start

Prerequisites: Python 3.12+, Node 20+, git. Docker is optional (Postgres).

```bash
cp .env.example .env            # add GEMINI_API_KEY (free: https://aistudio.google.com/apikey)

# API  → http://127.0.0.1:8001  (docs at /docs)
cd apps/api
python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"     # Windows; use .venv/bin on Unix
.venv/Scripts/python -m uvicorn archon.main:app --port 8001 --reload

# Web  → http://localhost:3001
cd apps/web
npm install && npm run dev
```

Open the web app, paste a git URL or a local path, and ARCHON will clone/scan it, build the graph,
detect the stack, and render the overview and the code map.

## LLM providers (free tiers)

Set `ARCHON_LLM_PROVIDER` to `gemini` (default), `groq`, or `xai` and the matching `*_API_KEY`.
Without a key, everything structural still works; only AI narratives are disabled. `mock` is a
deterministic offline provider used by the tests.

## Deployment

```bash
cp .env.example .env
docker compose --profile app up -d --build     # Postgres + API (:8001) + web (:3001)
```
Set `ARCHON_API_KEY` in `.env` (and `NEXT_PUBLIC_ARCHON_API_KEY` as a build arg for the web image)
to require `X-API-Key` on the API.

## Layout

```
apps/api      FastAPI backend: ingestion, extractors (tree-sitter), graph, LLM layer
apps/web      Next.js frontend: repositories, overview, interactive code map
scripts/      quiz_gate.py (process rule 3)
decisions.md  decision log — why things are the way they are
flow.md       execution flow + per-session changelog

```

## Tests

```bash
cd apps/api && .venv/Scripts/python -m pytest -q
cd apps/web && npm run lint && npm run build
```
