# ARCHON Decision Log

Every important technical decision is recorded here at the time it is made.
Entries are never deleted; a reversed decision gets `Status: Superseded by D-xxx`.

## Template

```
## D-000 — <short title>
- **Date:** YYYY-MM-DD
- **Status:** Accepted | Superseded by D-xxx | Rejected
- **Context:** What problem or situation forced a choice.
- **Decision:** What was chosen.
- **Alternatives considered:** Each option, one line on its trade-off.
- **Why this one:** The reasons, concretely.
- **Consequences:** What this makes easier/harder; what to revisit later.
```

---

## D-001 — Monorepo with a Python API and a Next.js web app
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** ARCHON needs a code-analysis engine (parsing, graphs, LLM orchestration) and an interactive UI (graph map, chat, dashboards). One repo keeps them in lockstep.
- **Decision:** Single repository, `apps/api` (Python 3.13 + FastAPI) and `apps/web` (Next.js + TypeScript). No workspace tool (no pnpm/turbo) — plain `npm` and `pip` since neither pnpm nor uv is installed on the dev machine.
- **Alternatives considered:**
  - All-TypeScript monorepo (Node API): one language, simpler hiring, but weaker ecosystem for static analysis and graph algorithms.
  - Separate repos: cleaner ownership, but version-skew pain for a solo project.
- **Why this one:** The heart of ARCHON is analysis. Python has tree-sitter bindings with a single multi-grammar package, `networkx` for graph algorithms, and mature SDKs for every LLM provider. React/Next.js is the best fit for a heavy interactive UI.
- **Consequences:** Two toolchains to run locally. Shared types must be mirrored (OpenAPI schema generated from FastAPI keeps them honest).

## D-002 — tree-sitter (via `tree-sitter-language-pack`) for multi-language parsing
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** The Code Graph must be built from repositories in arbitrary languages. We need fast, error-tolerant parsing that yields concrete syntax trees.
- **Decision:** Use `tree-sitter` with `tree-sitter-language-pack` (one wheel bundling 100+ grammars). Start with extractors for Python, TypeScript/JavaScript, Go, Java.
- **Alternatives considered:**
  - Per-language native ASTs (`ast` for Python, `typescript` compiler API for TS): most precise, but a separate toolchain per language and no uniform node model.
  - Regex heuristics: trivial to add languages, but brittle and blind to nesting.
  - LSP servers: precise symbols, but heavyweight to spin up per repo and language.
- **Why this one:** One API for all languages, tolerant of syntax errors (real repos have them), fast (C parsers), and the grammar pack ships pre-built wheels for Python 3.13.
- **Consequences:** Call-graph resolution is heuristic (name-based) rather than type-resolved; acceptable for v1 and can be layered with LSP later.

## D-003 — SQLite by default, Postgres + pgvector optional; SQLAlchemy 2 async as the ORM
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** The dev machine had no running Docker daemon at project start. Requiring Postgres would block the first run. But large repos and embeddings benefit from Postgres/pgvector.
- **Decision:** `DATABASE_URL` selects the engine. Default `sqlite+aiosqlite`, with `docker-compose.yml` providing `pgvector/pgvector:pg16`. All schema is written against SQLAlchemy 2 so both work. Embedding similarity is computed in Python for SQLite and can be pushed to pgvector for Postgres.
- **Alternatives considered:**
  - Postgres only: simplest single path, but zero-setup dev impossible without Docker.
  - Neo4j for the graph: native graph queries, but an extra service and query language; our graphs fit in memory per repo, so `networkx` in-process is enough.
  - DuckDB: great analytics, weak as an app DB.
- **Why this one:** Zero-friction first run, a clean upgrade path, and one ORM.
- **Consequences:** Must avoid Postgres-only SQL. Vector search in SQLite is O(n) — fine for repos under ~50k chunks.

## D-004 — Free-tier LLM providers behind one interface; Gemini is the default
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** The owner has no paid LLM API key. Free tiers exist for Google Gemini (AI Studio), Groq (Llama models), and xAI Grok. Features must not depend on any one vendor.
- **Decision:** `archon.llm` exposes `complete()`, `complete_json()`, and `embed()`. Providers: `gemini` (google-genai SDK), `groq` and `xai` (both OpenAI-compatible, via the `openai` SDK with a custom base URL). Selected by `ARCHON_LLM_PROVIDER` / `ARCHON_EMBED_PROVIDER`. Gemini is the default because its free tier also includes an embeddings model.
- **Alternatives considered:**
  - Anthropic Claude: best reasoning quality, but no free tier — rejected by the owner.
  - LiteLLM / LangChain as the abstraction: broad provider support, but heavy dependencies and abstractions we do not need; a 150-line adapter is easier to reason about.
  - Local models via Ollama: free and private, but slow on a laptop and adds a runtime.
- **Why this one:** Costs nothing, swappable by env var, and the JSON-mode helper gives structured output across providers.
- **Consequences:** Free tiers are rate-limited; the LLM layer needs retry/backoff and features must batch requests sensibly. Quality of deep reasoning is lower than paid frontier models.

## D-005 — Unified Code Graph as the single source of truth
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** ARCHON has 20 capabilities. Building each from raw files would duplicate parsing and produce inconsistent answers.
- **Decision:** One `nodes` + `edges` schema per repository. Node kinds: `repo, directory, file, module, class, function, method, endpoint, table, dependency`. Edge kinds: `contains, imports, calls, extends, implements, exposes, queries, depends_on`. Every capability reads from this graph (optionally loading it into `networkx` for algorithms).
- **Alternatives considered:**
  - Per-feature ad-hoc extraction: faster to prototype, but the "why" answers diverge between features.
  - Full semantic model (types, resolved symbols): ideal, but requires per-language LSPs.
- **Why this one:** One model, consistent answers, and graph algorithms (centrality, cycles, reachability) become reusable across change-impact, tech-debt, and dependency features.
- **Consequences:** The extractor quality bounds every feature; investing in extractors pays off everywhere.

## D-006 — Quiz gate enforced by a Claude Code PreToolUse hook
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** The owner requires that the AI quizzes them before major changes (commit, deploy, etc.) and proceeds only on a pass. A rule in CLAUDE.md alone can be forgotten.
- **Decision:** `scripts/quiz_gate.py` writes `.archon/quiz-pass.json` after a pass. A `PreToolUse` hook on `Bash` in `.claude/settings.json` blocks commands containing `git commit` / `git push` unless a marker younger than 30 minutes exists. The marker is git-ignored.
- **Alternatives considered:**
  - Git pre-commit hook: works outside Claude too, but would also block the owner's own manual commits.
  - Honor system only: zero code, but the owner explicitly asked for enforcement.
- **Why this one:** Blocks only AI-driven commits, cannot be skipped by forgetting, and is trivially auditable.
- **Consequences:** The AI must remember to run the pass command; a stale marker expires so a pass cannot be reused for a different change hours later.

## D-007 — Database tables are identified by name, not by the file that declares them
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** Testing on the fixture repo produced two `users` TABLE nodes: one from `migrations/001_init.sql` (CREATE TABLE) and one from the SQLAlchemy model with `__tablename__ = "users"`. Database intelligence and change-impact need a single node per real table.
- **Decision:** `Node.create` computes a TABLE node's id from `(kind, "", "table:<name>")`, ignoring the path. All declaring sites (SQL DDL, ORM models, Prisma models) collapse into the one node; each adds a CONTAINS edge from its file/class, so provenance is preserved through edges. The node keeps the first declaration's `path`/lines.
- **Alternatives considered:**
  - Keep one node per declaration and add a "same_table" edge: preserves detail but every consumer must dedupe.
  - Merge in the builder after extraction: same result, but more code and easy to forget in new extractors.
- **Why this one:** One line in the identity function; every extractor benefits automatically; QUERIES edges from code land on the same node regardless of which declaration exists.
- **Consequences:** Tables with the same name in different schemas/databases are merged (acceptable for v1; schema-qualified names can be added to the qualified name later).

## D-008 — Cytoscape.js + fCoSE layout for the interactive code map
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** The map must render anything from 20 top-level components to ~1,500 files/symbols, support click-to-inspect, double-click drill-down, and neighborhood focus.
- **Decision:** `cytoscape` with the `cytoscape-fcose` force layout, loaded client-side via dynamic `import()` inside a `useEffect` (no SSR). Layout switches to `draft` quality above 800 nodes and disables animation above 400. The API caps a view at 1,500 nodes, keeping the best-connected ones.
- **Alternatives considered:**
  - React Flow: superb DX for small hand-placed diagrams, but layout is external and performance degrades past a few hundred nodes.
  - D3 force: full control, but we would rebuild selection, zoom, styling, and hit-testing that Cytoscape already ships.
  - Sigma.js/WebGL: fastest for 10k+ nodes, but weaker interaction model and styling; overkill for per-level views.
- **Why this one:** Proven at thousands of nodes on canvas, selector-based styling maps directly onto our node/edge kinds, and fCoSE gives readable clustered layouts fast.
- **Consequences:** Cytoscape's API is imperative; the React wrapper (`GraphCanvas`) is the only place that touches it. Layout positions are not persisted yet (re-layout on every view change).

## D-009 — Client components fetch straight from the API; no server-side data fetching or SWR
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** Next.js pages could fetch from the API on the server (RSC) or the client. Repo status changes every second during ingestion and the map is fully interactive.
- **Decision:** Pages are thin server components that only unwrap route params; all data comes from client components using a small `useApi` hook (fetch + optional polling + manual refresh). No SWR/React Query dependency for now.
- **Alternatives considered:**
  - RSC fetching with `fetch()` caching: fewer client round-trips, but polling and interactivity would still need client code, and the API URL would differ between server and browser.
  - SWR / TanStack Query: excellent cache semantics, but adds a dependency and mental model for ~60 lines of hook.
- **Why this one:** One data path, trivially debuggable in the browser network tab, and `NEXT_PUBLIC_ARCHON_API_URL` is the only configuration.
- **Consequences:** No request dedupe across components (acceptable at current scale). Revisit when adding chat streaming (Phase 2) — SSE will need its own hook.

## D-010 — "Component roots" define the system-level view
- **Date:** 2026-09-08
- **Status:** Accepted
- **Context:** The first system view used top-level directories as components. On this monorepo that produced a single `apps` component; on a typical `src/`-rooted project it would produce just `src`. Neither is what an engineer means by "components".
- **Decision:** `RepoGraph.component_roots()` walks down from the repo root: a directory is a component if it directly contains source files or a package manifest (package.json, pyproject.toml, go.mod, …); a directory with only subdirectories is transparent and its children are considered instead, to a depth of 3. Manifest presence is recorded on directory nodes as `meta.manifests` by the graph builder. The system view, architecture components table, and coupling metrics all use these roots.
- **Alternatives considered:**
  - Fixed depth (always second-level directories): breaks for flat repos and deep monorepos alike.
  - LLM-chosen components: plausible but slow, non-deterministic, and unavailable without a key.
  - Community detection on the import graph (Louvain): principled, but clusters do not align with how the repo is laid out, which confuses users; keep as a later "logical components" option.
- **Why this one:** Deterministic, instant, matches how developers think about `apps/api` vs `apps/web`, and manifests are a strong signal of a deployable unit.
- **Consequences:** Repos whose top-level mixes files and directories get `(root)` as a pseudo-component. Depth limit 3 may under-split very deep monorepos.

## D-011 — Quiz gate disabled at the owner's request
- **Date:** 2026-09-17
- **Status:** Accepted (supersedes the enforcement part of D-006)
- **Context:** After the first quiz was issued, the owner asked to skip the quiz for this project from now on and to complete the implementation autonomously.
- **Decision:** The PreToolUse hook in `.claude/settings.json` is removed so commits are no longer blocked. `scripts/quiz_gate.py` stays in the repo for optional re-enablement. Rule 3 in `CLAUDE.md` is marked disabled; Rules 1 (decisions.md) and 2 (flow.md) are unchanged.
- **Alternatives considered:** Keep the hook but auto-pass (misleading audit trail); delete the script (loses the option to re-enable).
- **Why this one:** Honors the owner's instruction while keeping the mechanism one line away.
- **Consequences:** No forced knowledge check before commits; the session changelog in `flow.md` becomes the primary review aid.

## D-012 — One shared `Finding` model for every analyzer
- **Date:** 2026-09-18
- **Status:** Accepted
- **Context:** Seven analyzers (security, performance, debt, dependency, api, database, tests) plus AI code review all produce "problems". The health score, the findings UI, and the advisor need to consume them uniformly.
- **Decision:** `archon.analysis.findings.Finding` (analyzer, category, severity, title, description, path, lines, node_id, evidence, recommendation, confidence, tags) with a content-based `fingerprint` (analyzer + category + path + node/title + evidence prefix, deliberately *not* the line number). Persisted in one `findings` table; a re-run replaces an analyzer's open findings but preserves `resolved`/`dismissed` status by fingerprint.
- **Alternatives considered:** One table per analyzer (simpler queries per feature, but N copies of the UI and score logic); SARIF (industry standard, but heavier than needed and awkward for non-security findings).
- **Why this one:** One list, one filter UI, one scoring function; the fingerprint survives line drift so triage decisions stick across runs.
- **Consequences:** Analyzer-specific detail must fit `evidence`/`tags`; rich reports (API inventory, DB schema, dependency inventory) are separate report endpoints, not findings.

## D-013 — Hybrid retrieval: BM25 always, embeddings when available, fused by reciprocal rank
- **Date:** 2026-09-18
- **Status:** Accepted
- **Context:** Chat, docs, debugging, planning and review all need "the most relevant code for this text". Free-tier embedding APIs are rate-limited and may be absent entirely.
- **Decision:** Chunks are graph-derived (one per class/function/method, plus windows over symbol-less regions). A pure-Python BM25 over identifier-split tokens is built per repo in memory (cached). If an embedding provider is configured, chunks are embedded at index time (best effort, failures ignored) and query results are fused with BM25 via reciprocal rank fusion (1/(60+rank)). Vectors are stored as JSON in SQLite; pgvector remains a later optimisation.
- **Alternatives considered:** Embeddings-only (best semantic recall, but unusable without a key); an external vector DB (Chroma/Qdrant: another service); `rank-bm25`/`sentence-transformers` packages (fine, but ~40 lines cover BM25 and local embedding models are slow on laptops).
- **Why this one:** Works offline with zero keys, upgrades transparently, and the graph-derived chunking means every hit maps to a node (so answers can cite and the map can highlight).
- **Consequences:** Cosine over JSON vectors is O(n) per query — fine to ~50k chunks. Embedding the whole repo on a free tier can hit rate limits; the loop batches 100 and simply logs failures.

## D-014 — A deterministic `mock` LLM provider for tests and offline demos
- **Date:** 2026-09-18
- **Status:** Accepted
- **Context:** All AI workflows must be tested in CI without network or keys, and demoed offline.
- **Decision:** `ARCHON_LLM_PROVIDER=mock` selects `MockProvider`: JSON-mode calls return a superset object satisfying every prompt schema (`mock: true`), text calls echo a digest, embeddings are SHA-256-derived vectors. Integration tests run the entire analyze → chat → docs → debug/impact/feature/plan/advise/refactor/tests/review/logs flow against it.
- **Alternatives considered:** Monkeypatching provider calls per test (brittle, repeats setup); recorded HTTP cassettes (couple tests to vendor payloads).
- **Why this one:** One env var flips the whole system; tests exercise real prompt construction and response handling.
- **Consequences:** Mock answers are meaningless; tests assert structure and the deterministic (non-LLM) facts, never AI content.

## D-015 — Reasoning workflows return structural facts even without an LLM
- **Date:** 2026-09-18
- **Status:** Accepted
- **Context:** Debugging, impact, feature simulation, planning, advice, refactoring, test generation, review and log intelligence are "AI features", but the owner may run without a key.
- **Decision:** Every workflow computes a deterministic part from the graph first (parsed stack frames mapped to nodes, reverse-reachability impact with a risk score, diff→symbol mapping + rule checks, log clustering/timeline, heuristic test cases, hot-spot selection) and returns it as `facts`; the LLM part is `ai` with `ai_error` explaining absence/failure. The frontend renders both.
- **Alternatives considered:** Refuse without a key (simplest, but leaves most of ARCHON dark); fake narratives (misleading).
- **Why this one:** The structural half is often the more trustworthy half, and it makes the AI half auditable.
- **Consequences:** Prompts carry the facts explicitly, which keeps hallucination low but increases prompt size; budgets are capped per workflow.
