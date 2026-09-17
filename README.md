# ARCHON — AI Engineering Intelligence Platform

ARCHON understands, analyzes, and reasons about software systems end-to-end. It builds a
**Code Graph** of a repository (files, classes, functions, endpoints, tables, dependencies and the
relationships between them) and layers analysis and AI reasoning on top of it.

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Foundation, process rules (decisions.md, flow.md, quiz gate) | done |
| 1 | Ingestion, Code Graph, interactive map, architecture reconstruction | done |
| 2 | Embeddings, codebase chat, documentation generation | next |
| 3 | Security / performance / tech-debt / API / DB / dependency analyzers, health score | planned |
| 4 | Debugging, change impact, feature simulator, planner, code review, log intelligence | planned |
| 5 | Auth, job queue, deployment | planned |

## Quick start

Prerequisites: Python 3.12+, Node 20+, git. Docker is optional (Postgres).

```bash
cp .env.example .env            # add GEMINI_API_KEY (free: https://aistudio.google.com/apikey)

# API  → http://127.0.0.1:8000  (docs at /docs)
cd apps/api
python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"     # Windows; use .venv/bin on Unix
.venv/Scripts/python -m uvicorn archon.main:app --reload

# Web  → http://localhost:3000
cd apps/web
npm install && npm run dev
```

Open the web app, paste a git URL or a local path, and ARCHON will clone/scan it, build the graph,
detect the stack, and render the overview and the code map.

## LLM providers (free tiers)

Set `ARCHON_LLM_PROVIDER` to `gemini` (default), `groq`, or `xai` and the matching `*_API_KEY`.
Without a key, everything structural still works; only AI narratives are disabled.

## Layout

```
apps/api      FastAPI backend: ingestion, extractors (tree-sitter), graph, LLM layer
apps/web      Next.js frontend: repositories, overview, interactive code map
scripts/      quiz_gate.py (process rule 3)
decisions.md  decision log — why things are the way they are
flow.md       execution flow + per-session changelog
CLAUDE.md     working rules for the AI assistant
```

## Tests

```bash
cd apps/api && .venv/Scripts/python -m pytest -q
cd apps/web && npm run lint && npm run build
```
