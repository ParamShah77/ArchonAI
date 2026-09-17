# ARCHON Execution Flow

This file explains how the code runs: entry points, exit points, and the order
in which functions are called for each feature. Update it whenever a flow
changes. The **Session changelog** at the bottom records what the AI changed in
each session.

## 1. Processes and entry points

| Process | Entry point | Exit / output |
|---|---|---|
| API server | `apps/api/archon/main.py` → `create_app()` → uvicorn | HTTP responses (JSON) |
| Web app | `apps/web/app/layout.tsx` → route pages | Rendered UI, calls API |
| Quiz gate | `scripts/quiz_gate.py` | `.archon/quiz-pass.json` marker |
| Hook | `.claude/settings.json` → `scripts/quiz_gate.py check` | allow / block a Bash command |

## 2. API request lifecycle

```
uvicorn → FastAPI app (main.create_app)
  → CORS middleware
  → router (archon/api/routes/*.py)
    → dependency: get_session() (archon/db/session.py) opens an async DB session
    → service function (archon/services/*.py) does the work
    → returns pydantic schema (archon/api/schemas.py)
  → JSON response
```

## 3. Feature flows

### 3.1 Repository ingestion (Phase 1)
```
POST /repos {url | local_path}
  → routes/repos.create_repo
    → services/ingest.ingest_repository
      1. workspace.clone_or_copy(source) → local checkout under ARCHON_WORKSPACE
      2. scanner.walk_files(root) → list of source files (respects .gitignore-like rules)
      3. for each file: parsing.parse_file(path) → tree-sitter tree
      4. extractors.<language>.extract(tree, file) → nodes + edges for that file
      5. graph.builder.build(all_nodes, all_edges) → resolves imports/calls across files
      6. manifests.detect_dependencies(root) → dependency nodes + depends_on edges
      7. graph.store.save(repo_id, nodes, edges) → DB
      8. stack.detect(root, graph) → tech-stack summary stored on the repo row
  → 202 Accepted {repo_id, status:"ingesting"}   (work runs as a background task)
GET /repos/{id} → status: ingesting | ready | failed
```

### 3.2 Code Graph queries (Phase 1)
```
GET /repos/{id}/graph?level=system|file|symbol&focus=<node_id>&depth=N
  → routes/graph.get_graph
    → services/graph_query.subgraph(...)
      → loads nodes/edges for repo (cached networkx graph per repo)
      → filters by level, optionally takes the N-hop neighborhood of `focus`
  → {nodes:[...], edges:[...]}
GET /repos/{id}/nodes/{node_id} → node detail + source snippet + neighbors
GET /repos/{id}/search?q=... → name/path search over nodes
```

### 3.3 Architecture reconstruction (Phase 1, capability 1)
```
GET /repos/{id}/architecture
  → services/architecture.reconstruct(repo)
      1. stack.detect → languages, frameworks, package managers
      2. graph metrics → top-level components (directories/modules by size + coupling)
      3. entry points (main files, route files, CLI) by heuristics
      4. llm.complete_json(prompt with the above) → narrative + component list
  → ArchitectureReport
```

### 3.4 Web app (Phase 1)
```
apps/web/src/app/layout.tsx            shell: header + <ApiStatus/> (polls GET /health every 15s)
  /                                    page.tsx -> <RepoList/>
                                         useApi("repos") -> GET /repos (polls every 1.5s while any repo is pending/ingesting)
                                         submit -> POST /repos -> refresh()
  /repos/[id]                          layout.tsx awaits params -> <RepoShell id>
                                         RepoShell: GET /repos/{id} (polls while not ready), provides RepoContext, tabs
                                         page.tsx -> <RepoOverview/>: stats from repo row, GET /repos/{id}/architecture
  /repos/[id]/map                      page.tsx -> <GraphExplorer/> (URL search params are the view state:
                                         level | focus | depth | prefix | node)
                                         GET /repos/{id}/graph?...  -> <GraphCanvas/> (Cytoscape, fcose layout)
                                         tap node   -> selected -> <NodePanel/> GET /repos/{id}/nodes/{node_id}
                                         dbltap     -> drill(): directory -> prefix; file/symbol -> focus+depth
                                         search box -> GET /repos/{id}/search?q=  -> pick -> focus
```
Data hook: `src/lib/hooks.ts::useApi(key, fetcher, {pollMs, pollWhile})` — refetches when `key` changes;
`loading` is true only until the first result for the current key arrives.

## 4. Background work
Ingestion runs via FastAPI `BackgroundTasks` in-process (Phase 1). Phase 5 moves it to a Redis-backed queue.

## 5. Process tooling
```
Bash tool call in Claude Code
  -> .claude/settings.json PreToolUse hook
  -> python scripts/quiz_gate.py check   (reads {"tool_input": {"command": ...}} on stdin)
       command is a guarded git action (commit / push / merge)?  no  -> exit 0 (allowed)
       .archon/quiz-pass.json younger than 30 min?  yes -> exit 0
       otherwise -> exit 2 (blocked; message tells the AI to quiz the user first)
`python scripts/quiz_gate.py pass "<action>"` writes the marker after the user passes.
```

---

## Session changelog

### Session 2026-09-08 — Project bootstrap (Phase 0 → Phase 1)
**Phase 0 (foundation)**
- Created the repository, root config (`.gitignore`, `.env.example`, `docker-compose.yml`), `CLAUDE.md`, `README.md`, `decisions.md` (D-001..D-009), this file.
- `scripts/quiz_gate.py` + `.claude/settings.json` PreToolUse hook (Rule 3 enforcement). `.claude/launch.json` for running both servers.

**Phase 1 backend — `apps/api/archon/`** (all new)
- `config.py` — `Settings` (pydantic-settings), reads root `.env`; `resolved_database_url()` anchors SQLite paths to the repo root.
- `db/models.py` — `Repository`, `GraphNode`, `GraphEdge`, `ArchitectureReport`; `db/session.py` — async engine, `init_db()`, `get_session()` dependency.
- `graph/model.py` — `Node`, `Edge`, `FileExtraction`, `NodeKind`, `EdgeKind`, `LEVEL_KINDS`, `make_id()`; TABLE ids are path-independent (D-007).
- `ingest/workspace.py` — `clone_or_locate()` (shallow git clone or in-place local path), `remove_checkout()`.
- `ingest/scanner.py` — `walk_files()` (skip dirs, .gitignore via pathspec, size cap, extension→language), `read_text()`.
- `ingest/parsing.py` — cached tree-sitter parsers, `parse_source()`, `node_text()`, `line_span()`.
- `ingest/extractors/` — `base.Extractor` (shared helpers, SQL-in-string detection), `python`, `javascript` (JS/TS/TSX), `go`, `java`, `sql` (DDL + Prisma). Each returns a `FileExtraction` with nodes, CONTAINS/EXPOSES edges, and unresolved imports/calls/bases.
- `ingest/manifests.py` — `parse_manifest()` for package.json, requirements*.txt, pyproject, go.mod, pom.xml, gradle, Cargo, Gemfile, composer. `ingest/stack.py` — `detect_stack()`.
- `graph/builder.py` — `GraphBuilder`: directories, import resolution per language, call resolution heuristic (`_pick`: same file > imported files > unique global for bare calls > receiver/class name match), inheritance, SQL QUERIES edges, dependency nodes, stats.
- `graph/store.py` — `save_graph()` / `load_graph()` (batched inserts). `graph/query.py` — `RepoGraph` (networkx): `level_view()`, `neighborhood()`, `search()`, `metrics()`; `GraphCache` per repo.
- `llm/` — `LLMProvider` interface, `GeminiProvider`, `OpenAICompatProvider` (groq, xai), `registry.complete/complete_json/embed`, `extract_json()` tolerant parser (D-004).
- `services/ingest.py` — `analyze_checkout()` (CPU-bound, runs in a thread) and `ingest_repository()` background task with status transitions pending→ingesting→ready|failed.
- `services/architecture.py` — `heuristic_report()` (components, layers, entry points, coupling, metrics) + LLM narrative via `complete_json`; cached in `architecture_reports`.
- `api/routes/repos.py` — POST/GET/DELETE `/repos`, POST `/repos/{id}/reingest`. `api/routes/graph.py` — `/graph`, `/nodes/{id}`, `/search`, `/metrics`, `/source`, `/architecture`. `api/schemas.py`, `api/deps.py`. `main.py` — `create_app()`, `/health`.
- `tests/` — fixture repo (Python + TS + SQL) and 19 tests for extractors, builder/query, and the HTTP API (in-process ASGI, SQLite temp DB, no LLM).

**Phase 1 frontend — `apps/web/src/`** (all new; scaffolded with create-next-app, Next 16 / React 19 / Tailwind 4)
- `lib/api.ts` — typed API client + `KIND_STYLE`/`EDGE_STYLE` visual identity. `lib/hooks.ts` — `useApi`, `useDebounced`.
- `app/layout.tsx`, `app/globals.css` (dark engineering theme tokens), `app/page.tsx`.
- `components/ApiStatus.tsx`, `ui.tsx` (Spinner, StatusPill, KindBadge, Stat, Section…), `RepoList.tsx`, `RepoShell.tsx` (repo context + tabs), `RepoOverview.tsx` (stats, stack, components table, architecture narrative, metrics).
- `components/graph/GraphCanvas.tsx` (Cytoscape wrapper), `NodePanel.tsx` (detail + source + grouped relationships), `GraphExplorer.tsx` (toolbar, levels, filters, search, focus/drill state in URL).
- `app/repos/[id]/layout.tsx`, `page.tsx`, `map/page.tsx`.

**Repo hygiene**
- `.gitattributes` normalizes line endings to LF (git on Windows was warning about LF→CRLF rewrites on every file).

**Fixes made during verification**
- Python class-body `__tablename__` assignments are bare `assignment` nodes, not wrapped in `expression_statement`.
- Call resolution no longer links `obj.method()` to an arbitrary unique global with the same name (false positives like `MARKER.read_text` → `scanner.read_text`).
- FastAPI/Flask router prefixes are applied to routes; Django URLconf detection requires an actual `urlpatterns =` assignment.
- Duplicate TABLE nodes from SQL + ORM collapsed (D-007).
- ORM detection no longer treats every `*Model`/`*Base` subclass as a table (pydantic DTOs were showing up as tables); only `__tablename__` or a direct ORM base counts.
- System-level components are "component roots" (D-010): directories that contain files or a package manifest; transparent wrappers like `apps/` expand into their children. Directory nodes now carry `meta.manifests`.
- Call resolution (`GraphBuilder._pick` / `_match_receiver`): a call with a receiver (`obj.method()`) resolves only to a method whose class name relates to the receiver, or to a function whose module name equals the receiver, within the same language family. `session.get()` no longer links to `GraphCache.get`; a TS `api.graph.search()` no longer links to the Python `graph.py::search`.
- Cytoscape's injected stylesheet forces `position: relative` on its container, defeating Tailwind's `absolute` and collapsing the canvas to 0px; fixed with an inline style, plus a `ResizeObserver` that resizes/fits the graph. Body uses `h-full` (not `min-h-full`) so the map has a definite height chain; `main` scrolls.
