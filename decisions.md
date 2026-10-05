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

## D-016 — Optional shared-secret API key instead of user accounts (Phase 5)
- **Date:** 2026-09-18
- **Status:** Accepted
- **Context:** ARCHON is currently a single-operator tool run locally or on a private host. It needs a way to not be wide open when exposed, without building user management.
- **Decision:** `ARCHON_API_KEY` (unset by default). When set, an HTTP middleware requires `X-API-Key` on every route except `/health` and the OpenAPI docs; the web app sends `NEXT_PUBLIC_ARCHON_API_KEY`. No users, roles or sessions yet.
- **Alternatives considered:** OAuth/OIDC login (right for teams, but a large surface for a v1 with one operator); Basic auth (browser prompts are awkward with a SPA); no auth (unsafe once deployed).
- **Why this one:** Ten lines, zero dependencies, good enough for a private deployment; upgrade path to per-user auth is additive.
- **Consequences:** The key is baked into the web bundle at build time (public to anyone who can load the app) — acceptable only when the web app itself sits behind the same trust boundary. Multi-user needs D-0xx later.

## D-017 — Keep in-process background tasks; defer Redis/queue
- **Date:** 2026-09-18
- **Status:** Accepted (revisit when multiple API replicas or long analyses appear)
- **Context:** Ingestion and analysis run as FastAPI `BackgroundTasks` with status rows (`repositories.status`, `analysis_runs`). Phase 5 originally planned a Redis-backed queue.
- **Decision:** Stay in-process. Job state already lives in the database, so a crash leaves an honest `failed`/stale status and re-running is idempotent (findings replaced per analyzer; graph replaced per repo). Docker Compose ships Postgres + API + web without Redis.
- **Alternatives considered:** arq/Celery + Redis (durable retries, horizontal workers; another service and more ops for a single-node tool); Postgres-backed queue (no new service, but still a worker process to run).
- **Why this one:** Every current job finishes in seconds to a few minutes on one node; adding infrastructure now buys nothing the owner needs.
- **Consequences:** A job dies with the process; no retries; CPU-heavy analysis shares the API process (mitigated by `asyncio.to_thread` for parsing).

## D-018 — Fallback chain across free-tier providers; Groq primary, Gemini fallback and embeddings
- **Date:** 2026-10-03
- **Status:** Accepted (supersedes the "Gemini is the default" part of D-004; the provider interface from D-004 stands). Default chain order and timeout amended by D-020.
- **Context:** The first run with real keys (owner added Gemini + Groq) showed: (1) both default models were retired for this account (`gemini-2.5-flash` → 404 "no longer available to new users", `llama-3.3-70b-versatile` → 404); (2) Gemini 3.x models think before answering and thinking tokens count against `max_output_tokens`, so a small cap produced `finish_reason=MAX_TOKENS` with empty text; (3) the Gemini free tier returned 503 "high demand" and several calls took 50–110 s; (4) Groq answered every call in 0.2–1.3 s with valid JSON (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `openai/gpt-oss-20b`). Measured on 2026-10-03 with a pong + structured-JSON benchmark.
- **Decision:**
  - Completions go through `archon.llm.chain.FallbackChain`: `ARCHON_LLM_PROVIDER` first, then `ARCHON_LLM_FALLBACKS` (`provider` or `provider:model`). Each attempt has a timeout (`ARCHON_LLM_TIMEOUT`, 90 s); any failure moves to the next link; a failed link cools down 60 s and is tried last. Links without an API key are skipped, so a single-key setup still works. The answering link is recorded per task and status is exposed in `/health` (`llm_chain`).
  - Defaults: primary `groq:openai/gpt-oss-120b` (fast, 131k context, strongest reasoning of the available free models); fallbacks `gemini:gemini-3.5-flash-lite` (fastest reliable Gemini, ~1 s) then `gemini:gemini-3.8-flash` (the model Google recommends, but overloaded at times). Embeddings stay on `gemini-embedding-001` (Groq has no embeddings endpoint; verified working, 768 dims).
  - Gemini provider: +2048 output tokens of thinking headroom, `thinking_level=low` (configurable, retried without it if a model rejects it), automatic function calling disabled, and an error that names the finish reason when no text comes back. Groq/xAI: +1024 headroom for reasoning models.
  - Provider-level retries now cover only transient errors (429, 5xx, connection/timeout) with two attempts and short backoff; the old code retried 404s and waited up to 30 s ×4 before the caller learned anything. Embedding batches retry individually.
- **Alternatives considered:**
  - Keep Gemini primary, only fix model names: slowest and least available option on the measured day.
  - Use the moving alias `gemini-flash-latest`: never retired, but it took 52 s on structured JSON in the benchmark and changes behaviour silently.
  - LiteLLM router: has fallbacks built in, but a heavy dependency for ~100 lines (same reasoning as D-004).
  - Parallel "race" of all providers: lowest latency, but burns free-tier quota on every call.
- **Why this one:** Turns free-tier flakiness into a latency blip instead of a failed feature, keeps quota use to one provider per call in the normal case, and makes model retirement a config change rather than an outage.
- **Consequences:** Answers in one session can come from different models (visible in `/health` and logs). Model names will keep aging; `.env` is the single place to update them. Chain state is per-process.

## D-019 — SQLite concurrency: no read snapshot across slow awaits; paced background embeddings
- **Date:** 2026-10-03
- **Status:** Accepted
- **Context:** With real providers, `POST /index` and `GET /architecture?refresh=true` returned 500 "database is locked". Two mechanisms: (1) indexing opened a write transaction (DELETE chunks) and then awaited Gemini embeddings for many seconds, so every other writer timed out; (2) SQLite WAL gives a reading transaction a snapshot, and if anyone commits while that transaction waits on an LLM, upgrading it to a write fails immediately with SQLITE_BUSY_SNAPSHOT — the busy timeout does not apply. Separately, the Gemini free tier allows 100 embedded texts per minute (each batch item counts), and this repository alone has ~730 chunks, so inline embedding hit 429 and silently stored no vectors.
- **Decision:**
  - `db.session.end_read(session)` ends the current transaction before any slow await; it refuses to run with pending changes. Chat, architecture reconstruction, docs generation and indexing follow "read → end_read → LLM/embed → write → commit".
  - SQLite connections get a 30 s busy timeout. Indexing of one repo is serialized with a per-repo `asyncio.Lock`.
  - `index_repository` writes chunks immediately, reuses vectors of chunks whose text hash is unchanged, embeds inline only when the missing count fits one minute of quota (`ARCHON_EMBED_RPM`, default 90), and otherwise starts a paced background job (`context/embedder.py`) that embeds batches, sleeps to stay under the rate, honours the provider's retry delay, and stops after 5 consecutive failures. `GET /repos/{id}/index/status` reports progress.
  - Missing vectors are stored as SQL NULL (`JSON(none_as_null=True)`); queries also match the JSON text `null` written by earlier versions.
- **Alternatives considered:** Postgres only (no snapshot-upgrade failure, but D-003 keeps SQLite as the zero-setup default); `BEGIN IMMEDIATE` for every transaction (would hold the single write lock across LLM calls, blocking everyone); a job queue for embeddings (D-017 defers queues; an in-process task with DB-visible progress is enough on one node); embedding fewer chunks (loses retrieval quality).
- **Why this one:** Fixes the real failure modes without new infrastructure, makes indexing return in ~0.1 s, and makes re-indexing nearly free for unchanged code.
- **Consequences:** On a fresh large repo, semantic retrieval improves gradually over several minutes (BM25 works from the start). The background job dies with the process; the next `/index` call resumes it because missing vectors are recomputed from the table.

## D-020 — Budget-aware routing on Groq; learned limits; recovered JSON; answer attribution
- **Date:** 2026-10-03
- **Status:** Accepted (amends D-018 defaults)
- **Context:** Measured Groq free-tier limits are 8,000 tokens/minute and 1,000 requests/day per model, counted as prompt + requested `max_tokens`. Many ARCHON prompts carry 15–26k characters of code (≈5–8k tokens), and Groq also enforces an output-tokens-per-minute cap that appears only in error text ("Request too large … (OTPM): Limit N"). `gpt-oss-120b` occasionally fails JSON mode server-side with 400 `json_validate_failed`. Gemini 3.8 Flash exhausted its free quota within a few calls.
- **Decision:**
  - The Groq provider estimates prompt tokens (chars/3.2) and sizes `max_tokens` to fit the minute budget; if the prompt alone cannot fit, it raises `PromptTooLarge` before any network call and the chain moves on without cooling the link down.
  - Limits seen in "Request too large" errors (TPM or OTPM) are remembered per link and applied to later requests.
  - On `json_validate_failed`, the provider returns Groq's `failed_generation` text; the tolerant JSON parser and the existing one-shot repair recover it.
  - 429s are not retried in place; the chain cools the link down for the provider's own "try again in Ns" hint (capped), otherwise 60 s.
  - Default chain: `groq:openai/gpt-oss-120b` → `groq:qwen/qwen3.8-27b` (separate per-model budget) → `gemini:gemini-3.8-flash` → `gemini:gemini-3.5-flash-lite`; per-attempt timeout 60 s.
  - Every AI result carries `ai_model` (chat: `answered_by`); the UI shows it, and the header chip lists the chain with ok/failed counts.
- **Alternatives considered:** Shrink every prompt to fit 8k tokens (keeps Groq for everything, but cuts the code context that makes answers grounded); paid tier (rejected by the owner); round-robin across links (spreads quota but gives inconsistent quality for small prompts that Groq handles best).
- **Why this one:** Small prompts get the fastest strong model; large prompts go straight to Gemini's long context without wasting a request; quota errors become cooldowns sized by the provider itself.
- **Consequences:** Under load, many large-context answers come from Gemini Flash-Lite. Measured quality on this repository was good (correct impact analysis, caught the planted SQL injection), but it is the weakest link. Limit learning is per process and resets on restart.

## D-021 — Embedding pacer budgets tokens as well as texts, and backs off adaptively
- **Date:** 2026-10-03
- **Status:** Accepted (refines D-019)
- **Context:** After D-019 the background job still received 429s from Gemini. Measurements: a batch of 90 real chunks (~120k characters, ~36k tokens at a measured 3.30 chars/token) is refused while 20 chunks pass, and the error carries no quota metric — so besides the published 100 texts/minute there is an unpublished tokens-per-minute ceiling. A fixed token budget of 24k/min still drew occasional 429s.
- **Decision:** Each batch is limited by count (≤ texts/min, ≤ 100) and by estimated tokens (≤ half a minute's token budget, chars/3.4); after each batch the job sleeps for whichever of the two limits is tighter. On every 429 it lowers both rates by 25% (floors 10 texts / 2,000 tokens per minute) for the rest of the job. Defaults `ARCHON_EMBED_RPM=90`, `ARCHON_EMBED_TPM=20000`. Inline embedding during `/index` happens only when the missing chunks fit both budgets. The current rate is reported in `/index/status`. Unfinished jobs restart at API startup.
- **Alternatives considered:** Hard-code a lower constant (would be wrong for paid tiers or quota changes); exponential backoff only (keeps hitting the same ceiling every minute); local embedding model (no quota, but slow on a laptop and a large new dependency).
- **Why this one:** Converges on whatever the account actually allows without configuration, and still runs at full speed on accounts with higher limits.
- **Consequences:** A fresh 700-chunk repository takes roughly 15–25 minutes to embed fully on the free tier; keyword retrieval works throughout.

## D-022 — Code-map layout runs in a Web Worker, with cached positions
- **Date:** 2026-10-05
- **Status:** Accepted (refines D-008)
- **Context:** The owner reported the Code Map "not responding". Measured on this repository: the API returns every level in < 60 ms, but the fCoSE layout ran synchronously on the browser's main thread — 5.1 s for the Symbols level (776 nodes, 1,630 edges) at `quality: "default"`, which D-008 used up to 800 nodes. The page could not respond during that time, and the freeze recurred on every level switch, kind filter toggle, and focus change. Two console warnings also came from the map: an invalid canvas font (`var(--font-geist-mono)`; canvas cannot resolve CSS variables) and a custom `wheelSensitivity`.
- **Decision:**
  - `components/graph/layout.worker.ts` runs headless Cytoscape + fCoSE in a module Web Worker and returns positions; `GraphCanvas` shows the graph immediately on a spiral, displays "arranging N nodes…", then applies positions with a `preset` layout (animated below 400 nodes).
  - `layoutClient.ts` keeps one worker; a newer request terminates a still-running one (fCoSE cannot be interrupted, and its result would be discarded). Positions are cached by a hash of node and edge ids (24 entries), so revisiting a view is instant.
  - Worker uses `quality: "draft"` above 350 nodes (≈1 s instead of ≈5 s, visually close).
  - Rendering: `textureOnViewport` while panning/zooming; straight edges without arrows above 1,200 elements; concrete monospace font stack; default wheel sensitivity; the resize observer re-fits only on real size changes.
- **Alternatives considered:** Only lowering the draft threshold (still freezes ~1 s per change, and grows with repo size); chunked layout on the main thread via `requestIdleCallback` (fCoSE has no incremental API); switching to a WebGL library such as Sigma.js (larger rewrite; rendering was not the bottleneck); server-side layout in Python (adds a dependency and a round trip, and positions depend on client-side filters).
- **Why this one:** Removes the freeze entirely regardless of graph size, keeps the existing renderer and interactions, and needs no new dependency (Turbopack bundles `new Worker(new URL(...))`).
- **Consequences:** Verified in the browser: worst main-thread stall during a Symbols load dropped from 5,143 ms to 189 ms (the remaining cost is adding elements to the canvas); returning to a cached view skips layout. Very large graphs still take seconds to *arrange*, but the page stays usable meanwhile.

## D-023 — Code map: nested boxes packed in rows, force layout only between top-level blocks
- **Date:** 2026-10-06
- **Status:** Accepted (supersedes the layout part of D-008 and refines D-022)
- **Context:** The owner found the map "very very cluttered" (screenshots of all three levels). Measured on the Files level: 382 overlapping node pairs, 1,425 overlapping labels, 193 nodes squeezed into 412×371 px. Causes: the worker laid out nodes as size-less points (styles disabled), so drawn nodes and labels collided; every relationship, including `contains` and repo→package `depends_on`, was drawn as a line; all ~40 packages were shown in every view; sizes ranged 14–42 px and every node was labelled. Making fCoSE handle real sizes plus nested folder boxes was measured and rejected: the best of three parameter sets still left 24–56 overlapping boxes and ~30× more empty space than the nodes need, and `draft` quality produced 6,490 overlapping boxes on the Symbols level.
- **Decision:**
  - **Nesting instead of lines** (`viewModel.ts`): a node's `contains` parent becomes its compound box (folder → files → classes → methods). Symbols attached to functions (endpoints, nested functions) go into their file's box. On the Symbols level, where the API sends no folders, folders are rebuilt from file paths. Single-child folder chains collapse into one box (`apps/api/archon`), like VS Code compact folders. The repo root node and its `depends_on` spokes are not drawn; packages sit in one "External packages used" box, and only packages imported by something in the current view are shown.
  - **Structured layout** (`layoutCore.ts`): every box packs its children in rows (boxes tallest first, then nodes in a stable kind-then-name order, each row centred); every node gets the same slot height, so rows line up. Only top-level items are placed by fCoSE, as solid blocks with edges lifted to them, then pushed apart if they touch. Overlap is impossible inside boxes by construction, and the same repository always looks the same.
  - **Quieter drawing** (`GraphCanvas.tsx`): node sizes 12–26 px; labels on dark pills; folders, endpoints, tables and the top ~12% most-connected nodes are labelled at overview zoom, the rest appear as you zoom in, select or hover; edges are thin at 22% opacity and lines into the packages box at 7%; hovering a node or a whole box lights up its lines; selection keeps the containing boxes visible.
  - The map opens on the System level (top of the drill-down). Double-clicking a rebuilt folder drills into it.
- **Alternatives considered:** Tuning fCoSE further (measured above, not compact or overlap-free); edge bundling (needs a plugin and does not fix node overlap); a WebGL renderer such as Sigma.js (faster, but no compound boxes); hiding edges entirely at overview (loses the "what talks to what" signal; dimming plus hover keeps it discoverable).
- **Why this one:** It matches how engineers think about a codebase (folders and files), gives zero overlap by construction, and keeps relationship-aware placement where it matters (between top-level parts).
- **Consequences:** Measured in the browser on this repository — overlapping nodes, labels and boxes are 0 on all three levels; layout time 8 ms (Files), 28 ms (System), ~3–200 ms (Symbols). Within a box, placement is by name, not by connections, so a file's neighbours are found by hovering or selecting rather than by proximity. The whole-repo Symbols view is necessarily small; drilling into a folder is the intended way to read it.

## D-024 — Semantic-zoom code map ("zoom adds detail") with a soft component palette
- **Date:** 2026-10-06
- **Status:** Accepted (supersedes the System/Files/Symbols level switch from D-008 and the drawing rules of D-023; the structured layout of D-023 is kept)
- **Context:** After D-023 removed overlaps, the owner still did not like the map: they want it to start as a clear overview and add detail step by step as they zoom in, in a decent, soft colour theme, using a tool if needed. Three separate levels forced a choice of granularity up front, and every level drew everything at once.
- **Decision:**
  - **One hierarchy, loaded once:** `GET /repos/{id}/graph?level=all` returns every folder, file, symbol and package (no repo node, raw edges, cap 20,000 nodes). The client builds the nested view (D-023 `viewModel`) and lays it out once in the worker; the layout now returns a rectangle for every box, so a closed box occupies exactly the space its contents will.
  - **Level of detail by screen size:** a box is drawn as a solid *tile* (name + "10 folders · 64 files") until it covers ~30% of the screen area (or 70% of its width/height) and is on screen; then it becomes a faint *frame* and its children appear (fading in). Positions never move while zooming. Relationships are recomputed for what is visible: each code-level edge is drawn between the nearest visible stand-ins of its ends, parallel ones merged into one line whose thickness reflects the count; only lines with both ends on screen are drawn; lines inside one box are stronger than lines between boxes. Line and border thickness stay constant on screen at any zoom; tile text stays 10–20 px and moves under tiles too small to hold it.
  - **Cleaner hierarchy:** folders that contain only folders dissolve and their sub-folders take their place (`apps/api/archon`, `apps/web`), so the overview shows real components as peers instead of one wrapper box.
  - **Navigation:** double-click a tile to fly into it; a breadcrumb shows the deepest open box under the screen centre (click to go back up); "Overview" returns home; search flies to the result's box and selects it; links from other pages (`?node=`, `?focus=`, `?prefix=`) fly to their target.
  - **Soft palette:** each top-level component gets its own low-saturation hue (sky, mint, lavender, peach, rose, teal, periwinkle, sand) that its folders and files inherit as solid tints mixed into a slate background (`#12151c`), so lines pass neatly behind tiles; leaves use a softened kind palette, which is shared with badges app-wide (`KIND_STYLE`).
  - **Tooling:** kept Cytoscape (already used, handles show/hide of ~1,000 elements and per-element styling); semantic zoom is ~200 lines on top of it.
- **Alternatives considered:** Sigma.js/graphology (WebGL, very fast, but no box nesting and the same LOD logic would still be custom); React Flow sub-flows (good visuals, weaker at ~1,000 nodes and no zoom-dependent rendering); a D3 zoomable treemap/circle pack (natural "zoom into a box", but relationships between boxes are awkward to show and it would replace the whole canvas); keeping the three levels with better styling (does not give "detail as you zoom").
- **Why this one:** Matches the owner's mental model (a map you zoom into), keeps every view small enough to read (5 items at overview, ~40–80 when inside a folder or file), and reuses the existing layout, worker and interactions.
- **Consequences:** Measured on this repository (837 items): overview 5 tiles and 4 lines; inside `apps/api/archon` 16 items; inside `services` 43; inside one file ~70. No main-thread task over 50 ms during a 20-step zoom sweep; whole-hierarchy layout 34–55 ms. Very large repositories load all nodes in one response (fine to tens of thousands; beyond that the endpoint would need paging by subtree). Camera moves jump instead of animating in hidden tabs.
