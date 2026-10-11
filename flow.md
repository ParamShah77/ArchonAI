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
| Hook (disabled, D-011) | `.claude/settings.json` → `scripts/quiz_gate.py check` | allow / block a Bash command |
| Docker | `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml --profile app` | containers on :8001 / :3001 |

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
  /repos/[id]/map                      page.tsx -> <GraphExplorer/>  (semantic zoom D-024; renderer D-026, D-027, D-029, D-031)
                                         GET /repos/{id}/graph?level=all  (whole hierarchy, once; cached per repo
                                            version while you visit other tabs)
                                         -> <MapCanvas/>: viewModel.buildView() (nesting; wrapper and single-file
                                            folders dissolved; "Other files"; empty marker files hidden; packages box;
                                            tiers; symbol details) -> worker layoutCore.runLayout(nodes, edges with
                                            kinds): dependency-ranked boxes, call-flow layers, aligned columns ->
                                            rectangles -> mapModel.buildMapModel() (areas, OKLCH palettes, summaries,
                                            facts: fan-in/out, tested-by, hubs; integer edge arrays) -> onKey() ->
                                            <MapLegend/>; goHome() (or the camera saved in sessionStorage)
                                         lens = Health -> GET /repos/{id}/findings?status=open&limit=2000 ->
                                            computeHealth() (weight per KLOC -> 5 bins) -> tiles blend to the scale
                                         d3-zoom (wheel / pinch / drag), keys, <MapControls/> -> target -> requestDraw()
                                         renderFrame(): glide -> openness (settles at rest) -> emphasis + lens easing
                                            -> frame fills + strips -> resting lines (integer merge, budget, edge
                                            fade, routing at rest, spread ports, quiet hubs) -> box bodies (Health
                                            colours, findings marks) -> chips / cards (hub bubbles, Health rings) ->
                                            sockets -> labels -> selection veil + its world -> focused lines -> hovered
                                            line -> glint -> rings / preview ring -> landing pulse -> edge tags ->
                                            breadcrumb -> hover re-pick
                                         pointer: rest 250 ms -> hover card (node facts, or a line's contents);
                                            click: tag -> flyToPair; line -> flyToPair; node -> ring now, panel after
                                            220 ms; right-click -> <NodeMenu/> -> zoom / inspect / onAction
                                         onAction / panel buttons -> nodeActions.runAction(): Tools page, Chat ?q=,
                                            copy path, VS Code / GitHub
                                         zoom end / landed flight -> saveCamera() (sessionStorage per repo)
                                         ?node=, ?focus= -> zoomTo; ?prefix= -> zoomToPath; ?debug=map overlay
```
Data hook: `src/lib/hooks.ts::useApi(key, fetcher, {pollMs, pollWhile})` — refetches when `key` changes;
`loading` is true only until the first result for the current key arrives.

### 3.5 Codebase chat (Phase 2)
```
POST /repos/{id}/chat {question, conversation_id?}
  → routes/intelligence.chat → services/chat.ask
      1. load conversation (or create) + last 8 messages as history
      2. build_context: context/index.retrieve(query)  (BM25 ⊕ embeddings, RRF)  → chunks
                        graph_facts(nodes mentioned in question + chunk nodes) → relationship sentences
      3. llm.complete(system=SYSTEM, history, prompt=context+question)   (skipped if no provider)
      4. persist user + assistant messages (sources JSON on the assistant row)
  → {conversation_id, answer, sources[]}
Retrieval index: services/ingest.ingest_repository → context/index.index_repository (after graph save)
  chunker.build_chunks(ctx) → CodeChunk rows (+embedding when available) → retrieval_cache.invalidate
  POST /repos/{id}/index rebuilds on demand (?embeddings=true|false)
```

### 3.6 Analysis (Phase 3)
```
POST /repos/{id}/analyze {analyzers?}      → AnalysisRun row (pending) → BackgroundTasks(run_analysis_job)
  run_analysis_job(run_id)
    → run_analyzers(): for each name in ANALYZERS: analyzer.run(AnalysisContext) → list[Finding]
                       save_findings(): replace open findings for that analyzer, keep resolved/dismissed by fingerprint
    → compute_and_store_health(): findings + tests report → health.compute_health → HealthSnapshot row
    → run.status = done | failed
GET /repos/{id}/findings?analyzer&severity&status&path   PATCH /findings/{id} {status}
GET /repos/{id}/health-score?recompute   GET /api-intel   GET /db-intel   GET /dependencies   GET /tests-intel
Analyzers: security (regex rules + endpoint auth rule), performance (codeshape.analyze_body per function),
debt (function/class/file rules, dead code, duplication windows, import cycles), dependency (report → findings),
api (duplicate routes, verbs, GET mutations, versioning), database (orphans, PK, bulk writes), tests (coverage gaps).
```

### 3.7 Documentation (Phase 2)
```
POST /repos/{id}/docs/generate {kinds?} → services/docs.generate
  per kind: gen_<kind>(ctx) builds Markdown from graph/report facts, then _narrate() asks the LLM for a
  narrative section (skipped without a provider) → Document rows (replace per kind)
GET /repos/{id}/docs   GET /repos/{id}/docs/{doc_id}
```

### 3.8 Reasoning workflows (Phase 4) — services/reasoning.py
```
POST /debug {error, description}   stacktrace.parse → resolve_frames (frames → nodes) → excerpts + graph_facts
                                   + retrieve(error text) → LLM JSON {hypotheses, root_cause, fix, verification}
POST /impact {node_id|path|symbol, depth, change, ai}
                                   impact.resolve_target → analyze_impact (reverse reachability over
                                   calls/imports/extends/queries; endpoints via exposes; tests via imports; risk score)
                                   → optional LLM JSON {will_break, safe_if, tests_to_run, migration_steps}
POST /feature?mode=simulate|plan  retrieve(description) → component hits → LLM JSON plan
POST /plan                         same as feature with mode=plan
POST /advise {question}            reconstruct() + open findings + retrieve → LLM JSON {recommendations, alternatives}
POST /refactor {node_id?|path?}    debt findings → hottest file (or longest function) → impact → LLM JSON {proposals}
POST /tests/generate {node_id}     source + callees/callers + heuristic cases → LLM JSON {code, cases}
POST /review {diff, title}         parse_diff → changed symbols → analyze_impact per symbol + security rules on
                                   added lines → LLM JSON {verdict, findings, side_effects, missing_tests}
POST /logs {logs, description}     analyze_logs (levels, templates, timeline, bursts, code refs) → LLM JSON {timeline, root_cause}
```

### 3.9 LLM calls (D-018, D-020)
```
feature code → archon.llm.complete / complete_json
  → registry.get_chain()  (cached; links = ARCHON_LLM_PROVIDER + ARCHON_LLM_FALLBACKS, minus links without keys)
  → FallbackChain.complete(): order links (cooling-down links last)
      for each link: asyncio.wait_for(link.complete(...), ARCHON_LLM_TIMEOUT)
        Groq/xAI: _completion_budget() → PromptTooLarge (skip, no cooldown) | sized max_tokens
                  → API call → 429: _learn_limit() → raise | 400 json_validate_failed → return failed_generation
        Gemini:   thinking headroom + thinking_level → API call → no text → LLMError(finish_reason)
      success → stats.ok, last_answered_by = "provider:model", return text
      failure → stats.failed, cooldown (provider hint or 60 s), next link
  → all failed → LLMError listing every link's reason
complete_json: extract_json(text) → on failure one repair call through the same chain
Embeddings: archon.llm.embed → Gemini directly (not the chain)
```

### 3.10 Retrieval index with paced embeddings (D-019)
```
index_repository(session, ctx)            [per-repo asyncio.Lock]
  1. previous vectors by sha256(text) from existing chunks
  2. build_chunks(ctx) → rows (reuse vector when text unchanged)
  3. DELETE old chunks + INSERT rows → commit   (write lock held briefly)
  4. missing = rows without vector
       missing ≤ ARCHON_EMBED_RPM → embedder.embed_batch() inline
       else → embedder.start(repo_id): background task
              loop: embed_batch(≤ texts/min, ≤ tokens/min ÷ 2) [read → end_read → embed → UPDATE → commit → invalidate cache]
                    sleep max(60·n/texts_per_min, 60·tokens/tokens_per_min)  (D-021)
                    on 429: both rates × 0.75, sleep provider retry delay or 60 s; stop after 5 consecutive failures
GET /repos/{id}/index/status → {pending, running, total, embedded, last_error}
API startup (main.lifespan) → embedder.resume_all(): restart jobs for repos that still have chunks without vectors
```

## 4. Background work
Ingestion and analysis run via FastAPI `BackgroundTasks` in-process; embedding runs as an `asyncio` task per repo (D-019). No external queue (D-017).

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

### Session 2026-10-12 (later) — Code Map tier 3 (decision D-031)
- `MapCanvas.tsx`:
  - Health: `computeHealth`, `healthTile`, the lens easing (`lensT`), findings marks and rings;
  - hover cards: `TipRows` / `EdgeRows` with a 250 ms dwell;
  - lines: `pickEdge`, `drawTags`, `flyToPair`, `spreadPorts`, quiet hubs and bubbles;
  - right-click `NodeMenu`, `preview()`;
  - speed: integer-array merge in `buildCurves`, pixel snapping at rest (`toScreen`), opaque context with the background painted on resize, one-path grid;
  - `saveCamera` and camera restore in `goHome`.
- `mapModel.ts`: facts (`fanIn`, `fanOut`, `testedBy`), hubs (`hubIn`), `index`, `test` / `muted` / `inner`, integer arrays (`byIndex`, `chain`, `eSrc`, `eTgt`, `eKind`, `eExt`). Summaries skip nested functions.
- `palette.ts`: test chroma, muted chips, `HEALTH_BINS` / `HEALTH_TILES` / `HEALTH_LABELS`.
- `viewModel.ts`: `TEST_PATH_RE`, tiers, package order and muting, nested functions, tables in files, empty marker files hidden.
- `layoutCore.ts`: `rankChildren` (dependency order), `sortKids` tiers, call-flow layers for the functions of mixed files, sibling edges lifted per box. `layoutClient.ts`: `tier` / `path` sent, `LAYOUT_VERSION` 5.
- New `nodeActions.ts` (`editorHref`, `actionHref`, `runAction`) and `map.css` (menu keyframe).
- `NodePanel.tsx`: action buttons, Facts, Findings, Imported by tests, direction colours.
- `GraphExplorer.tsx`: lens toggle, findings fetch, Health key, `onAction`, graph cache, camera `storageKey`, search preview.
- `ChatPanel.tsx`: `?q=` prefill. `lib/api.ts`: findings `limit`.
- Tests: Vitest (`vitest.config.ts`, `map.test.ts`, 12 tests, `npm test`).
- Verified at 1362×928 (simulated visible tab):
  - Health lens (260 findings, 299 nodes coloured), hover card after the dwell, right-click menu and Esc, 6 edge tags and tag flight, line hover card, search preview ring;
  - details panel actions and sections, Chat prefill (not sent), camera restored after visiting Chat, hub bubbles, muted dev packages;
  - merge validated 59/59 pairs identical; frames about 1 ms p50 at rest;
  - lint, type-check, build, 12 web tests and 40 backend tests pass.

### Session 2026-10-12 — Workspace safety fix and graph relationships (tier 3, part 1)
- `apps/api/archon/ingest/workspace.py`:
  - new `_remove_tree` (clears read-only flags) and `_refresh_clone` (in-place fetch and reset, guarded);
  - `_git(ceiling=)` sets `GIT_CEILING_DIRECTORIES`;
  - `_describe(ceiling=)`;
  - `clone_or_locate` refreshes or re-clones;
  - `remove_checkout` uses `_remove_tree`.
- Incident during this session: an unguarded first version reset ARCHON's own repo. It was recovered from the reflog (see D-030) and the lost uncommitted work was re-applied.
- `apps/api/archon/graph/builder.py`:
  - `_python_submodules` / `_python_full_module`: `from pkg import sub` links to the submodule;
  - `_js_suffix`: unique suffix fallback for aliases;
  - dependency `meta.fixture`.
- New `archon/graph/paths.py` (`TEST_PATH_RE`, also used by `analysis/base.py`).
- Tests:
  - `test_workspace.py`: read-only removal, plus the incident regression;
  - `test_builder.py`: submodule imports, fixture packages.
- Flow: the re-index of a cloned repo now goes clone_or_locate -> `_refresh_clone` (guarded) or `_remove_tree` + `git clone`.

### Session 2026-10-11 (later) — Code Map batch 2
- The owner said "next": tier 2 of `docs/code-map-plan.md` implemented with the recommended defaults (decision D-029).
- New `apps/web/src/components/graph/palette.ts`: OKLCH/OKLab conversion, `mixOklab`, `contrast`, map tokens, `boxPalette(index, depth, neutral)`, `chipPalette()`, focus direction colours.
- New `MapControls.tsx`: zoom +/−, fit current, fit all.
- `MapCanvas.tsx` reworked:
  - drawing: `drawFrameFill` (header strip), `drawBox` (palette, file corner, class border), `queueTileName` (tile-sized names), `queueFrameTitle` (sibling title size, ◆ for classes, clickable underline);
  - lines: `buildCurves` (budget, edge fade, direction colours, `route` + `buildObstacles`, cached choices), `strokeCurve` (casing), `drawSockets`;
  - focus: `drawVeil`, `drawGlint`, `drawPulse`, `drawRing` (grow-in);
  - symbols: `chipGeom` (capped chips, cards), `drawGlyph`, `drawCard`;
  - interaction: `pick` (title bands), `onDoubleClick`, keyboard handler, `zoomBy`, `panBy`, `upOneLevel`, `fitCurrent`, `ensureVisible`, `visibleRect` (`insetRight`, `insetBottom`), translate extent, centre kept on resize, app font.
- `mapText.ts`: `FontSpec`, half-pixel width cache.
- `mapModel.ts`: `pal`, `chip`, `areaIndex`, `priv`, `isComponent`, `detail`/`detail2`, sibling `bandWorld`.
- `viewModel.ts`: `details()`, `priv` / `isComponent`; sortKey puts public before private.
- `layoutCore.ts`: `layerLeaves` (call-flow layers), `bestGrid` (columns), scaled gaps and padding, `equaliseRows`, edges with kinds. `layoutClient.ts`: edge kinds sent to the worker, `LAYOUT_VERSION`.
- `GraphExplorer.tsx`: panel slides over the map, Esc closes it, `/` focuses search, search ↑/↓/Enter with 2 pings, controls, and the key on palette tokens with a new hint.
- `NodePanel.tsx`: fills its overlay container.
- `lib/api.ts`: file kind colour `#8bc7e5`.
- Verified at 1362×928 (simulated visible tab, canvas snapshots):
  - overview, archon (open, wires plugging in), services, reasoning.py (call flow), hover, selection veil with amber/periwinkle lines and glint, DebtAnalyzer, deep-zoom cards, web/components, and portfolio Projects.jsx with `</>` components;
  - the panel opens over the map with the canvas still 1362 px; Esc closes it;
  - `+`, Backspace, `0`, zoom buttons, title hover/click, search Enter (flight then 2 pings);
  - frames p50 2.2 ms, p95 5.6 ms;
  - lint, type-check, build and 36 backend tests pass.

### Session 2026-10-11 — Code Map design review: step 0 + batch 1
- Ran an 8-lens design review with adversarial verification of the map (85/90 proposals survived). Plan and critic notes saved to `docs/code-map-plan.md`. The owner said "continue with plan": step 0 + batch 1 implemented (decisions D-027, D-028).
- Backend: `archon/graph/builder.py::_resolve_js` resolves `@/` and `~/` from the importing app's folder upwards (monorepos); test `test_ts_path_aliases_resolve_inside_a_monorepo_app`. Re-indexed ArchonAI: apps/web file-to-file imports 0 -> 69, and the stale map (GraphCanvas.tsx) was replaced by current code.
- `apps/web/src/components/graph/MapCanvas.tsx` rewritten:
  - camera: time-based glide about the cursor, new `wheelDelta`, `fly()` from the drawn view with a path-length duration, reduced motion, grabbing cursor;
  - level of detail: settle at rest with hysteresis (`anim` state), one-card opening (`drawFrameFill`, `drawBox`, `da` alpha);
  - lines: `drawEdges` uses neutral ink, rare-kind dashes, quiet package threads, lens curves and focused lines on top;
  - labels: label queue (`queueTileName`, `queueFrameTitle`, `drawLabels` with pill collisions), dot-to-chip cross-fade in `drawChip`;
  - interaction: `drawRing` (accent selection ring, light hover ring), `refreshHover`, deferred click / double-click fly / double-click empty `zoomOut`, tooltip for shortened names;
  - robustness: `contextrestored` / `visibilitychange` redraws, error-chip self-clear, fade-in, `?debug=map` overlay, `insetBottom` so fits stay above the key.
- New `mapText.ts`: `measure`, `fit`, `fitSmart` (extension-keeping middle ellipsis, `…/file`), `fitParts`.
- `mapModel.ts`: `MapEdge.external`, area/neutral/files/isType/quiet/lines fields, hues by area name, ranked `summarize()`, `dominant` root.
- `viewModel.ts`: short method labels plus `fullLabel`, single-file folder merge, "Other files"/"Root files" groups, `isType`, `quiet`, `lines`, 30-unit leaf footprint, "Packages" label.
- `layoutCore.ts`: `shelf()` + `bestShelf()` aspect search, `placeRoots()` packing; fCoSE, `separateRigid` and the `cytoscape`, `cytoscape-fcose` and `@types/cytoscape` dependencies removed (`src/types/cytoscape-fcose.d.ts` deleted). Added `d3-interpolate`.
- `GraphExplorer.tsx`: `MapLegend` from the model (areas, symbols, line samples; collapsible; reports its height), "Fit all", repo-root crumb, `history.replaceState` URL sync, map background before the first frame. `lib/api.ts`: `EDGE_STYLE.dash`. `next.config.ts`: `devIndicators: false`.
- `apps/web/src/app/globals.css`: restored `--color-danger` (an uncommitted edit had removed it, which broke the red error styling). Left uncommitted together with that edit's font change, for the owner to confirm.
- Verified at 1362×928 (simulated visible tab, canvas snapshots):
  - views: overview, archon, services, reasoning.py, DebtAnalyzer, web/components, packages, selection, hover, and the portfolio repo with its dominant `src`;
  - settling: 0 half-open boxes 1 s after each of 5 wheel pauses; frames p50 4.7 ms, p95 9.5 ms;
  - clicks: a click shows the ring at once with the URL 220 ms later; a double-click flies without selecting; a double-click on empty space steps out; the tooltip shows shortened names;
  - the overview sits above the key;
  - lint, type-check, build and 36 backend tests pass.

### Session 2026-10-10 — Code Map: never stay blank
- Owner saw an empty Code Map (toolbar shown, no map) in their browser; it rendered correctly in a clean browser at the same size, so the renderer was hardened against the plausible causes.
- `apps/web/src/components/graph/MapCanvas.tsx`: new `goHome()` places the camera only once the canvas has a real size (a 0×0 canvas at load gave zoom 0 forever); `resize()` retries it, `renderFrame()` waits for it. `draw()` now wraps `renderFrame()` and shows "drawing failed: …" in the corner chip (and the console) instead of a silent blank canvas. `roundRect()` falls back to arcs on browsers without `CanvasRenderingContext2D.roundRect`.
- Flow change (§3.4): the home view is applied on model build or on the first resize with a non-zero size, whichever comes later.
- Follow-up: `fitCanvas()` measures the container directly (ResizeObserver stays silent in hidden tabs and could leave the canvas 0×0 although its box had a size). Called by `goHome()`, every `renderFrame()`, the ResizeObserver and a window `resize` listener; after the model is built, `place()` retries `goHome()` every 250 ms until it succeeds. Verified: loading the Portfolio_Param map in a hidden 0×0 tab, then giving it 1362×928, now draws the overview.
- Root cause found: the setup effect's cleanup cancelled the pending animation frame but left its id in `S.frame`, so `requestDraw()` believed a frame was queued and never drew again. React's development double-mount runs that cleanup on every load; only visible tabs were affected (hidden tabs schedule with `setTimeout`, which the cleanup did not cancel). Fix: `requestDraw()` records `frameByTimer`; cleanup cancels with the matching call and resets `S.frame = 0`. Verified by simulating a visible tab (visibilityState + requestAnimationFrame) at 1362×928: overview draws, wheel zoom glides and settles.

### Session 2026-10-07 — Silence extension-caused hydration warning
- Owner's console showed a hydration mismatch on `<html>` caused by browser extensions adding attributes before React loads (`data-qb-installed`, `suppresshydrationwarning`), alongside unrelated errors from the Lusha extension (`dashboard-services.lusha.com` 401, CSP blocks, Stripe.js).
- `apps/web/src/app/layout.tsx` `RootLayout`: `suppressHydrationWarning` on `<html>` (one level only; mismatches inside the page still warn). No flow change.

### Session 2026-10-07 — Change Web port from 3000 to 3001
- Changed default web frontend port from 3000 to 3001 to resolve port collisions with other local projects.
- Updated `apps/web/package.json` (`next dev -p 3001`, `next start -p 3001`), `apps/web/Dockerfile` (`EXPOSE 3001`), `.env` / `.env.example` (`ARCHON_CORS_ORIGINS`), `apps/api/archon/config.py` (`archon_cors_origins`), `.claude/launch.json` (web port & url), `docker-compose.yml` (web port & CORS), `README.md`, `apps/web/README.md`, and `flow.md`.

### Session 2026-10-07 — Change API port from 8000 to 8001
- Changed default API server port from 8000 to 8001 across backend, frontend, environment configs, docker configuration, launch configuration, and documentation.
- Files updated: `.env`, `.env.example`, `apps/web/.env.local`, `apps/api/archon/config.py` (`archon_api_port`), `apps/web/src/lib/api.ts` (`API_URL`), `.claude/launch.json`, `docker-compose.yml`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `README.md`, `CLAUDE.md`, `apps/web/README.md`, `flow.md`.

### Session 2026-10-06 (evening) — Code Map: smooth canvas renderer
- Owner found the map basic and stuttering and asked about tools like three.js. Replaced the Cytoscape renderer with d3-zoom + a custom Canvas2D renderer (decision D-026, which explains why not three.js).
- New `apps/web/src/components/graph/MapCanvas.tsx`: `draw()` (eased camera, openness/visibility walk, `drawGrid`, `drawFrame`, `drawEdges`, `drawTile`, `drawPill`, `drawChip`, `drawHalo`, `updateCrumbs`), `pick()`, `zoomTo()`, `zoomToPath()`, `fly()`, `homeTransform()`; d3-zoom wiring, ResizeObserver, tooltip; same `MapController`/`Crumb` API as before.
- New `mapModel.ts`: `buildMapModel()`, `tint()`, `withAlpha()`, `summarize()` (moved out of the old canvas).
- Deleted `GraphCanvas.tsx`. `GraphExplorer.tsx` uses `<MapCanvas/>`; new hint text.
- `layoutCore.ts`: `pack()` takes gaps and a recurse flag; up to 12 top-level blocks are packed in rows with a scaled gap. `viewModel.ts`: wider leaf footprints for chip labels; packages group labelled "Packages (N)".
- `package.json`: d3-zoom, d3-selection, d3-transition, d3-ease (+ types).
- Verified in the browser with canvas snapshots: overview (5 closed tiles, no overlaps), `apps/api/archon`, `services`, `reasoning.py`, mid-zoom fades, hover glow; real wheel events through d3-zoom, click -> panel + `?node=`, double-click fly, breadcrumb, `?prefix=apps/web`. Frame time ~1.6 ms. Lint, type-check and production build pass.

### Session 2026-10-06 (security) — Patch Next.js advisories
- `npm audit` in `apps/web` showed a critical in `next` (RCE in `next/og` `ImageResponse`, which ARCHON does not use) and highs in `brace-expansion` and `braces` (lint tooling).
- `apps/web/package.json`: `next` and `eslint-config-next` 16.3.4 → 16.3.8 (exact pins). `apps/web/package-lock.json`: `@next/*` to 16.3.8 and `brace-expansion` to 1.1.21 / 5.0.12 via non-forced `npm audit fix`; no other packages moved.
- Remaining: 5 high advisories, all from one `braces@3.0.3` chain under `@next/eslint-plugin-next`. No patched `braces` exists, and it is dev-only, so it was accepted (decision D-025).
- No code or runtime flow changes. Lint, `tsc --noEmit` and `next build` pass.

### Session 2026-10-06 (later) — Code Map: semantic zoom and soft palette
- Owner rejected the nested static map: wants an overview first and detail added step by step while zooming, with a soft colour theme.
- API: `routes/graph.get_graph` accepts `level=all` (whole hierarchy, `MAX_NODES_ALL`); test added in `tests/test_api.py`.
- `apps/web/src/components/graph/GraphCanvas.tsx` rewritten: `buildModel()`, `toElements()`, `summarize()`, `tint()`, `fly()`; `refreshDetail()` (level of detail, merged on-screen relationships, constant strokes, adaptive tile text, breadcrumb), `applySelection()`, `zoomTo()`, `zoomToPath()`, `reset()`; trailing-safe viewport throttle.
- `GraphExplorer.tsx` rewritten: one `level=all` request, Overview button, breadcrumb, search that flies to results, deep links, legend.
- `viewModel.ts`: wrapper folders (only sub-folders) dissolve into path-named children. `layoutCore.ts`: `runLayout()` returns `Rect` for every node; `headerFor()` uncapped.
- `lib/api.ts`: soft `KIND_STYLE` / `EDGE_STYLE` palette (shared with badges); `GraphLevel` includes `all`.
- Verified in the browser: overview 5 tiles → archon 16 → services 43 → a file ~70; double-click, breadcrumb, Overview, tap→panel, search→fly and select, `?prefix=` all work; no long tasks during a zoom sweep; snapshots reviewed at four depths. Lint, type-check, build and 35 backend tests pass. Decision D-024.
- The API on port 8000 was restarted from the session's launch configuration so it serves `level=all`.

### Session 2026-10-06 — Code Map: neat and clear
- Owner sent screenshots of a cluttered map. Measured on Files: 382 overlapping nodes, 1,425 overlapping labels (worker laid out size-less points).
- `apps/web/src/components/graph/viewModel.ts` (new): `buildView()` — compound parents from `contains`, orphan symbols into their file, folders rebuilt from paths on Symbols, compact folder chains, packages box with only used packages, edge filtering, sizes, label footprints, `isSynthetic()`.
- `apps/web/src/components/graph/layoutCore.ts` (new): `runLayout()` — `pack()` rows per box, `placeRoot()` fCoSE on top-level blocks with lifted edges, `separateRigid()`, `emit()`.
- `layout.worker.ts`: now a thin wrapper over `layoutCore`. `layoutClient.ts`: `viewKey()`; sends parents, footprints and sort keys.
- `GraphCanvas.tsx`: compound-box styles, label pills and progressive labels, quieter edges, hover lights up connections, selection keeps containing boxes lit, synthetic ids ignored for selection, animation skipped in hidden tabs, preset fits final positions.
- `GraphExplorer.tsx`: default level System; double-click on a rebuilt folder sets the path prefix.
- Verified in the browser: 0 overlapping nodes, labels and boxes on System (27 nodes), Files (135 nodes, 41 boxes) and Symbols (631 nodes, 185 boxes); rendered snapshots reviewed. Lint, type-check and production build pass. Decision D-023.

### Session 2026-10-05 — Code Map freeze fix
- Owner reported the Code Map hanging. Measured: API < 60 ms per level; fCoSE on the main thread took 5,143 ms for the Symbols level (776 nodes), freezing the page on every view change. Most of the pasted console output came from a browser extension (Lusha), not ARCHON.
- `apps/web/src/components/graph/layout.worker.ts` (new): headless Cytoscape + fCoSE in a Web Worker.
- `apps/web/src/components/graph/layoutClient.ts` (new): `computeLayout()`, `cachedLayout()`, `graphKey()`; single worker, stale runs terminated, LRU position cache.
- `apps/web/src/components/graph/GraphCanvas.tsx`: `render()` shows nodes immediately and applies worker positions; "arranging N nodes…" / error chip; `textureOnViewport`; straight edges for large graphs; literal font stack; default wheel sensitivity; resize observer re-fits only on size changes.
- Verified: worst main-thread stall 189 ms during a Symbols load; level switches responsive; cached views skip layout; lint, type-check and production build pass. Decision D-022.

### Session 2026-10-03 — Real LLM keys: provider fixes and fallback chain
- Owner added Gemini and Groq keys. Smoke tests showed both keys authenticate but the default models (`gemini-2.5-flash`, `llama-3.3-70b-versatile`) are retired for this account; Gemini 3.x returned empty text because thinking tokens consumed the output cap; Gemini free tier also returned 503 "high demand" and some calls took 50–110 s.
- `llm/gemini.py`: thinking headroom (+2048 output tokens), `thinking_level` (default low, dropped automatically if a model rejects it), AFC disabled, error names the finish reason; retries only 5xx/429; `_embed_batch` retries only 5xx.
- `llm/openai_compat.py`: `PromptTooLarge`, `estimate_tokens`, `_completion_budget` (TPM/OTPM-aware), `_learn_limit`, `_failed_generation` recovery; retries only 5xx/connection/timeout.
- `llm/chain.py` (new): `FallbackChain` with per-attempt timeout, cooldowns from provider hints, `last_answered_by` context var, `status()`.
- `llm/registry.py`: `get_chain()`, `chain_specs()`, `reset()`, `llm_status()`; links without keys skipped. `config.py`: `archon_llm_fallbacks`, `archon_llm_timeout`, `gemini_thinking_level`, `groq_tpm_limit`, `archon_embed_rpm`; new default models.
- `db/session.py`: 30 s SQLite busy timeout, `end_read()`. `db/models.py`: `CodeChunk.embedding` stores SQL NULL.
- `context/index.py`: `index_repository` reuses vectors by text hash, writes first, inline-or-background embedding, per-repo lock. `context/embedder.py` (new): paced background job + progress; `resume_all()` restarts unfinished jobs at API startup. `GET /repos/{id}/index/status`.
- `services/chat.py`: reads → `end_read` → LLM → writes; returns `answered_by`. `services/architecture.py`, `services/docs.py`: `end_read` before LLM calls. `services/reasoning.py`: every result has `ai_model`.
- `main.py` + `schemas.HealthOut`: `/health` returns `llm_chain` and `embeddings`.
- Web: `lib/api.ts` types; header chip lists the chain; chat replies, tool results and the architecture card show which model answered.
- Tests: `tests/test_llm_chain.py` (new, 7 tests) and an embedding reuse/background test; 35 total, all offline.
- `.env` (owner's, not committed): provider/model/fallback lines updated, keys untouched. `.env.example` documents the chain.
- Embedding pacing refined (D-021): token-based batch sizing (measured 3.30 chars/token), adaptive 25% slowdown on 429, `resume_all()` at startup; `ARCHON_EMBED_TPM`.
- Verified live: all 13 AI endpoints return 200 with AI output on this repository; forced-failure handover works; a chat answer in the UI shows its model.

### Session 2026-09-18 — Phase 4 frontend + Phase 5 hardening
- `apps/web/src/lib/api.ts`: types + endpoints for findings, runs, health, intel reports, chat, docs, tools; optional `X-API-Key` header.
- `components/Markdown.tsx` (react-markdown + GFM), `components/JsonView.tsx` (generic structured-result renderer).
- Pages + panels: `chat/` (`ChatPanel`: conversations, sources → map deep links, reindex), `audit/` (`AuditPanel`: run analyzers with polling, health gauge + dimensions + history, findings filters/triage), `intel/` (`IntelPanel`: API, Database, Dependencies, Tests tabs), `docs/` (`DocsPanel`: generate per kind, markdown viewer), `tools/` (`ToolsPanel`: 9 workflows with a node picker, `ImpactResult`, `ReviewResult`, `LogsResult`).
- `RepoShell` tabs: Overview · Code Map · Chat · Audit · Intel · Docs · Tools.
- Phase 5: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml` `app` profile (Postgres + API + web); `ARCHON_API_KEY` middleware in `main.py` (D-016); background jobs stay in-process (D-017).
- Quality fixes after a live run on this repository: query-in-loop detection now needs SQL text, an unambiguous data-access method, or a data-access receiver (`db.`, `session.`, …) — generic `count()/update()/findall()` no longer count; security rules skip regex/rule-definition lines; MD5/SHA1 downgraded to low; test coverage is computed by import reachability from test files (depth 4) instead of direct imports only; softer tests penalty in the health score.

### Session 2026-09-17/18 — Phases 2–4 backend (analysis, chat, docs, reasoning)
- Owner disabled the quiz gate (D-011): `CLAUDE.md` Rule 3 marked disabled, hook removed from `.claude/settings.json`.
- `db/models.py`: added `AnalysisRun`, `FindingRow`, `CodeChunk`, `Document`, `HealthSnapshot`, `Conversation`, `ChatMessage`.
- `analysis/`: `findings.py` (Finding, severity weights, D-012), `base.py` (Analyzer, AnalysisContext, tokenizer, test-path detection), `codeshape.py` (per-function structural facts), `security.py`, `performance.py`, `debt.py`, `dependency.py`, `api_intel.py`, `db_intel.py`, `tests_intel.py`, `health.py`, `runner.py`.
- `context/`: `chunker.py`, `index.py` (BM25, RRF fusion, retrieval cache, `index_repository`, `graph_facts`) (D-013).
- `llm/mock.py` + registry: deterministic provider (D-014).
- `services/chat.py`, `services/docs.py`, `services/stacktrace.py`, `services/impact.py`, `services/reasoning.py` (D-015).
- `api/routes/analysis.py`, `api/routes/intelligence.py`; `main.py` includes them; `services/ingest.py` builds the retrieval index after ingestion.
- `tests/test_intelligence.py`: unit tests (codeshape, stack traces, diff, logs) + one end-to-end flow through every new endpoint with the mock provider.
- `pyproject.toml`: E501 ignored for rule/prompt-heavy modules.

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
