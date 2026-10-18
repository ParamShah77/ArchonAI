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

## D-025 — Patch `next` / `eslint-config-next` to 16.3.8; accept the unfixable `braces` advisory in lint tooling
- **Date:** 2026-10-06
- **Status:** Accepted
- **Context:** `npm audit` in `apps/web` reported 1 critical and 6 high advisories. Critical: `next` 16.2.0–16.3.5, Remote Code Execution in `next/og` `ImageResponse` (GHSA-vcvr-r3jv-pc5j). ARCHON does not import `next/og` or `ImageResponse` (grep over `apps/web/src` and config is empty), so it was not exploitable here, but it is a framework-level critical and the fix is a patch release. High: `brace-expansion` DoS advisories (via `eslint` → `minimatch@3` and `typescript-eslint` → `minimatch@10`), and `braces` (GHSA-vfj7-8cjw-p6xm) reached via `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob@3.3.1` → `micromatch` → `braces@3.0.3`.
- **Decision:**
  - Pin `next` and `eslint-config-next` to **16.3.8** (exact, as before; same minor, current `latest`). `@next/env`, `@next/eslint-plugin-next` and the `@next/swc-*` binaries follow to 16.3.8.
  - Run non-forced `npm audit fix`, which only moved `brace-expansion` 1.1.18 → 1.1.21 and 5.0.9 → 5.0.12 inside existing ranges. Nothing else in the lockfile changed (diffed package-by-package).
  - **Accept** the remaining `braces` chain (5 high entries, one root cause). The advisory covers `braces <=3.0.3`, and 3.0.3 is the newest version published, so no patched release exists. npm's only offered "fix" is `npm audit fix --force`, which downgrades `eslint-config-next` to 14.2.35 (two majors back, incompatible with Next 16 and flat config).
- **Alternatives considered:**
  - `npm audit fix --force`: removes the warning by downgrading lint config to Next 14. Breaks lint rules for Next 16 and trades a theoretical lint-time DoS for real tooling breakage.
  - `overrides` to swap `fast-glob` for a picomatch-based glob (e.g. tinyglobby) under `@next/eslint-plugin-next`: different API, could silently break the plugin's page-detection rule. Too fragile for a dev-only advisory.
  - Upgrading to a 16.4 canary: unrelated churn, not a stable release, and the plugin still depends on `fast-glob`.
- **Why this one:** It fixes the critical and every advisory that has a real fix, with patch-level bumps only. The leftover `braces` issue is a stack-exhaustion DoS triggered by attacker-controlled glob patterns. Here it runs only inside ESLint on the developer machine, with patterns from our own config. It is not in the production bundle or the server runtime.
- **Consequences:** `npm audit` still shows 5 high (the `braces` chain) until `braces` ships a fix or `@next/eslint-plugin-next` drops `fast-glob`. Revisit on the next Next.js bump. Lint, `tsc --noEmit` and `next build` pass on 16.3.8 with no code changes.

## D-026 — Code map renderer: d3-zoom camera + custom Canvas2D drawing with continuous level-of-detail fades
- **Date:** 2026-10-06
- **Status:** Accepted (replaces the Cytoscape renderer of D-024; the semantic-zoom idea, `level=all` data, view model and worker layout of D-023/D-024 are kept)
- **Context:** The owner found the D-024 map "very basic, not smooth, and stuttering" and asked whether a tool like three.js would help. Causes: Cytoscape re-styles and shows/hides hundreds of elements on each (throttled) viewport change, so detail popped in steps; its wheel zoom jumps in discrete increments; its drawing style (flat shapes, plain labels) is limited.
- **Decision:**
  - **Camera:** `d3-zoom` handles wheel, pinch and drag, with finer wheel steps. The drawn view eases toward d3's target every frame (log-space zoom, ~24% per frame), so wheel zoom glides. Fly-to (double-click, breadcrumb, search, deep links) uses a d3 transition with a cubic in-out ease over 850 ms. Hidden tabs jump instead of animating.
  - **Renderer:** one `<canvas>`, redrawn only when something changes (requestAnimationFrame; `setTimeout` in hidden tabs), DPR-aware. A frame takes ~1.6 ms on this repository. Drawn in screen space, so text is crisp at every zoom.
  - **Continuous level of detail:** each box has an openness `t` in [0, 1] from its on-screen size (smoothstep over 30–48% of the screen area or 72–84% of a side), gated so nothing opens until the camera is past the home view. The tile fades out (alpha `1-t`) while the frame and children fade in (alpha `t`, multiplied down the tree). Text is staggered: a tile's name clears by `t=0.35`, children's names start at `t=0.4`, and the frame title (in its own band) fades in over 0.15–0.5, so labels never overlap mid-zoom.
  - **Relationships:** each code-level edge is spread over the chain of nodes that currently stand in for its ends, weighted by how visible and closed each is, then merged per pair. Lines cross-fade from folder↔folder to function↔function as you zoom. Lines inside one box are clear; lines between boxes are quiet; lines to off-screen nodes appear only for the hovered/selected node (fading toward the screen edge). Curved, with arrowheads and a glow when highlighted.
  - **Look:** dot grid that subdivides smoothly with zoom; gradient tiles with soft shadow and a light top edge; symbols as rounded chips (kind dot + monospace name) or soft dots when too small to read; names of small tiles in pills drawn above all tiles; glow halo for hover and selection; HTML tooltip for symbols.
  - **Layout tweaks:** up to 12 top-level blocks are packed in rows (biggest first) with a gap that scales with the map, instead of fCoSE, which scattered a few very differently sized blocks; leaf footprints are wide enough for chip labels; the packages group is labelled "Packages (N)".
- **Alternatives considered:**
  - **three.js / WebGL (incl. react-three-fiber):** the map is a flat 2D diagram; WebGL only pays off beyond tens of thousands of shapes (we draw at most ~200 per frame). Crisp text needs SDF font atlases, rounded boxes and shadows need custom shaders, and a 3D camera tends to make code maps harder to read. Hundreds of kB of JS and much more code for no visible gain at this scale.
  - **PixiJS:** WebGL 2D, same text and rounded-shape trade-offs, plus its own scene graph to keep in sync.
  - **Keep Cytoscape and tune it:** cannot fade elements continuously without re-styling every element on every frame, which is what made it stutter.
  - **SVG (React or D3):** easy styling, but hundreds of DOM nodes updated per frame during zoom are slower than one canvas.
- **Why this one:** Canvas2D gives full control of the look (gradients, shadows, glow, crisp text) at ~1.6 ms per frame; d3-zoom is the small, proven answer for smooth pan/zoom/fly-to, so input handling is not hand-written.
- **Consequences:** The renderer is our own code (`MapCanvas.tsx`) rather than a library's; individual nodes are reached by search and the side panel rather than DOM elements. Cytoscape stays only for fCoSE placement of more than 12 top-level blocks in the worker. If a repository ever needs many thousands of visible items per frame, the drawing calls can move to WebGL (PixiJS) without changing the model or camera.

## D-027 — Code map, batch 1 of the design review: settle at rest, one-card opening, quiet lines, honest labels, screen-shaped boxes
- **Date:** 2026-10-11
- **Status:** Accepted (amends D-026's level-of-detail and text-stagger rules; supersedes the root placement of D-023 and the "lines coloured by kind" rule of D-024/D-026; restores D-023's quiet external lines). The full review is in `docs/code-map-plan.md`.
- **Context:** The owner asked for the map to be "readable, nice, proper, very smooth colouring, actions, everything properly visible". An 8-lens review with adversarial verification found: boxes rest half-open (see-through tile over a second frame, blank pills); lines drawn under tiles, hooked in gutters, green on green inside files, package lines the loudest thing on the overview; name size following character count; repeated method prefixes; summaries hiding endpoints/tables and counting TS interfaces as classes; tall single-column boxes; colours that could swap between areas; a key that did not match the map. The owner said "continue with plan" without answering the open questions, so the recommended defaults were used: settle boxes at rest, hover lights lines only (no dimming yet).
- **Decision:**
  - **Settle at rest:** while the scale is changing (wheel, pinch, flight, or within 180 ms of the last change), a box's openness follows its on-screen size continuously. Once scaling stops it eases (τ 85 ms) to fully open or closed, with hysteresis (opens from 0.55, closes below 0.45). Never while a button is held, and never in hidden tabs or with reduced motion (it snaps there).
  - **One card:** the open frame surface is drawn fully and the tile body fades away over it, with one shared radius and one border that morphs from the tile's to the frame's. Drawing alpha for children (`da`) is separate from the edge weights (`vis`). The tile name fades out over t 0–0.3 while the header title fades in over 0.05–0.3.
  - **Lines:** relationships at rest are one neutral ink (#a9b3c4). Hue and dash patterns appear only for extends, implements, exposes and queries (`EDGE_STYLE.dash`). Package lines are faint dotted threads with no arrowhead. Curves bow perpendicular to their own direction, so A→B and B→A form a lens, with no bend under 30 px and arrowheads only where there is room. Lines of the hovered or selected item (or anything inside it) are drawn on top of tiles.
  - **Labels:** all text goes through one queue drawn after shapes and lines. Titles are kept in the visible part of their box. Name size follows the tile, not the name. Names shrink a little, then shorten keeping the extension (`RepoOv…ew.tsx`, `…/IntelPanel.tsx`). Summaries drop whole parts instead of cutting words. Pills under tiny tiles are placed largest-tile-first and skipped on collision; the tooltip always has the full name, path, contents and line count.
  - **View model:** methods inside their class box drop the class prefix. A folder holding one file merges into it (`chat/ChatPanel.tsx`). Loose symbol-less files next to sub-folders gather into "Other files (n)" / "Root files (n)". TS interfaces count as types. Summaries are ranked (structure first for folders; endpoints and tables first for files). Leaf footprint is 30 units (chip plus gap; the old 18-unit label slot is gone).
  - **Layout:** each box tries 24 row widths and keeps the one whose finished box is closest to aspect 1.55 (the map's shape with and without the side panel) with the least empty space, avoiding single columns of four or more leaves. Top-level blocks use the same packing; fCoSE and the `cytoscape`/`cytoscape-fcose` dependencies are removed.
  - **Colour and key:** area hues are assigned by area name, so they never swap. Packages and loose-file groups are neutral surfaces with a dashed border. A root holding at least 70% of the files is opened on the overview. The key is built from the model (areas, symbol kinds, line styles present), is collapsible, and fits keep content above it.
  - **Camera:** a time-based glide (τ 65 ms) zooms about the cursor. Wheel step is ×1.19 per notch, with native-speed touchpad pinch and clamped deltas. Flights start from the drawn view and their duration scales with the path length (400–1100 ms, CSS "ease" curve). Reduced motion is respected and the cursor shows "grabbing" while dragging.
  - **Interaction:** a click shows the ring at once and reports the selection after 220 ms, so a double-click flies without opening the panel. A double-click on empty space steps out one level. The hover target is re-picked after the camera moves. The URL syncs through `history.replaceState`. The Next.js dev indicator is off because it covered the key.
  - **Robustness and tooling:** the canvas redraws on `contextrestored` and on becoming visible, a successful frame clears an old error chip, and the canvas fades in on its first frame. `?debug=map` shows frame-time p50/p95, boxes, half-open count and the settled state.
- **Alternatives considered:** always continuous openness (rejected: half-open rest states were the main readability complaint); snapping instantly at rest (a visible blink); dimming the map on hover (critic: strobes while sweeping, so deferred to a click-only option in batch 2); keeping kind colours on all lines (green lines on green chips merged into one mass); hierarchical edge bundling (curves cross unrelated tiles in nested boxes); keeping fCoSE for many roots (non-deterministic, about 424 KB, and packing does as well for top-level blocks); a minimap (adds chrome; breadcrumb and Fit all suffice).
- **Why this one:** each change removes a measured defect from the review without changing the approved direction (calm overview, detail as you zoom in, soft colours). Verified at 1362×928 in a simulated visible tab: no box half-open 1 s after each of 5 wheel pauses; frames p50 4.7 ms, p95 9.5 ms.
- **Consequences:** a box can finish opening or closing on its own about a quarter-second after you stop zooming. The batch-2 items stay open: click-to-dim focus, perceptual palette, type scale, call-flow order inside files, side panel over the map, keyboard and zoom buttons. Layout caches from older footprints are invalidated automatically (viewKey hashes w/h).

## D-028 — Resolve TypeScript path aliases (`@/`, `~/`) relative to the importing app in monorepos
- **Date:** 2026-10-11
- **Status:** Accepted
- **Context:** `@/lib/api` was resolved only against `<repo>/lib/api` and `<repo>/src/lib/api`. In a monorepo the app lives at `apps/web`, so every alias import failed and the frontend had 0 file-to-file import edges. The map showed no relationships for the whole web app, and impact analysis missed them too.
- **Decision:** walk up from the importing file's folder, nearest first, and try `<dir>/<path>` and `<dir>/src/<path>` with the usual extensions and `index` files. The first hit wins; the repo root is the last candidate, so single-app repos behave as before.
- **Alternatives considered:** parsing every `tsconfig.json` / `jsconfig.json` `paths` mapping (exact, but needs JSONC parsing, `extends` chains and baseUrl handling; a later refinement if repos with unusual aliases appear); a suffix match over all files (ambiguous when two apps have the same `lib/api.ts`).
- **Why this one:** it matches the near-universal `@/* → ./src/*` convention with a few lines of code and prefers the importing app's own files, so it cannot cross apps when the same path exists twice.
- **Consequences:** after re-indexing ArchonAI, apps/web has 69 file-to-file import edges (was 0). Aliases that map elsewhere (e.g. `@/` to `app/`) still need the tsconfig-aware version. Test: `test_ts_path_aliases_resolve_inside_a_monorepo_app`.

## D-029 — Code map, batch 2: perceptual palette, focus on click, lines that plug in, call-flow files, panel over the map, actions, symbol cards
- **Date:** 2026-10-11
- **Status:** Accepted. It amends D-027 and supersedes D-024's palette (tint() in sRGB) and D-023's "leaves by name" order inside files. The plan is in `docs/code-map-plan.md` (tier 2).
- **Context:** The owner asked for the next step ("next") without answering the open questions, so the recommended defaults were used:
  - call-flow order inside files;
  - dimming only on click (the critic warned that hover-dimming strobes);
  - the strongest folder links always shown at rest.
- **Decision:**
  - **Palette (`palette.ts`, OKLCH):** each area gets an equal-lightness hue in cool-first order (warm hues only from the 7th area, toned down). The open-surface lightness ramp stops at depth 2, so a closed tile always stands ≥1.56× brighter than its surface. Open boxes get a faint header strip. Files show a folded corner; classes get a ◆ title and a border leaning to the class colour. The file kind colour is now oklch(.80 .075 230) (deuteranopia-safe against class). All text is ≥5.5:1 contrast, names ≥7:1 (checked with `contrast()`).
  - **Type:** text widths are cached at half-pixel buckets and scaled, so zoom frames hit the cache. Canvas text uses the app's own font family. A tile's name size comes from the tile's own size; one sibling group shares a title size of 13–16 px. Summaries are 12 px in frames and only shown with names of 14 px or more on tiles.
  - **Lines:**
    - Resting lines between tiles enter each tile a little and are redrawn over it (source dot + arrowhead), so a wire visibly plugs in.
    - When the camera settles, resting lines are routed around unrelated tiles and chips: other side, then a wider bow, else hidden. The choice is cached while moving, so lines never flip mid-zoom.
    - Only the 10 strongest folder/file links show fully, the next 8 taper, and the rest appear on focus. Lines fade over 120 px at the screen edge.
    - Focused lines get a dark casing.
  - **Focus:**
    - A selection veils everything else at 30% (an open selected box stays unveiled) and redraws its own world on top: the item, its neighbours, and name pills for up to 12 far neighbours.
    - Its lines use direction colours: amber "uses", periwinkle "used by", rose "both". The colours are blended in OKLab as the emphasis eases (in 60 ms, out 110 ms).
    - A new selection sends one glint along up to 6 lines, skipped when more than 12 are lit or under reduced motion.
    - Hover only brightens and colours lines (no veil).
  - **Layout (`layoutCore.ts`):**
    - Files with 3+ internal calls/extends/implements/exposes are laid out in call-flow layers: longest path from entry points, endpoints and tables on top, deterministic cycle breaking, 4 barycenter sweeps, public before private. Small layers can share a row.
    - Other symbol lists become left-aligned columns.
    - Gaps between tiles scale with the tiles (6% of the median side, 14–80). Padding and header scale with the box.
    - Tiles in a row share top and bottom edges (heights within 1.5×), and nearly-full rows fill out.
    - The worker now receives edge kinds; `LAYOUT_VERSION` invalidates old caches.
  - **Panel:** the details panel slides over the map (220 ms in, 180 ms out) instead of resizing it. Fits, openness and the breadcrumb use the visible part of the map (minus the panel and the key). A selection under the panel is panned into view by the smallest move. A window resize keeps the centre.
  - **Actions:**
    - Open boxes' title bands are clickable: hover underlines them and lights their outside lines, click selects.
    - Double-click: into a tile; on a chip, select and ping; on a title or empty space, step out (fitting the room first if it is not fitted).
    - Keys on the focusable map: Backspace up, Esc clear, Enter fly in, 0/Home fit all, +/− zoom, arrows pan (Shift for bigger steps). `/` focuses search, and search supports ↑/↓/Enter.
    - Zoom buttons (+, −, fit current, fit all) sit in the corner and move aside for the panel.
    - The camera cannot be flung away (translate extent = map bounds + 25%).
    - After a flight lands, the target pings once (twice from search).
  - **Symbols:** chips stop growing at 30 px. Deep zoom fades in a card sized to its content: name, signature · line range · async, decorators. Endpoints show method and route, packages version and ecosystem, classes their bases. Each kind has a glyph (● ◆ ▶ ▭ tag). Private Python helpers are quieter (hollow mark, muted name). React components get a `</>` mark.
- **Alternatives considered:**
  - Hover-dimming after a dwell (strobes while sweeping across dense files).
  - The plan's sibling-median tile name size (made big tiles' names tiny next to many small siblings; tile-dimension sizing already gives equal tiles equal names).
  - Barycenter-first order within layers (measured 103 vs 83 crossings in reasoning.py).
  - Edge bundling (curves cross unrelated tiles).
  - A minimap (more chrome).
  - Recolouring all kind colours app-wide (badges everywhere would change).
- **Why this one:** each change targets a measured defect or a missing action from the review, keeps the calm direction, and stays cheap. Measured at 1362×928 in a simulated visible tab:
  - frames p50 2.2 ms, p95 5.6 ms;
  - downward call lines 181 → 279 and upward 109 → 28 across files;
  - fitted boxes open fully; 0 half-open boxes at rest;
  - all text contrast ≥ 5.5:1.
- **Consequences:**
  - Call-flow order replaces alphabetical order inside files with internal calls; names are still found via search or the tooltip.
  - Folder links beyond the strongest 18 appear only on focus.
  - The panel now covers the right of the map instead of shrinking it.
  - Tier 3 items remain open: Health lens, hover cards with more facts, edge tags at the screen edge, right-click actions, backend relationship fixes, bundled exits.

## D-030 — Workspace clones: refresh in place, but never let git escape the clone folder; graph relationship fixes
- **Date:** 2026-10-12
- **Status:** Accepted
- **Context:**
  - **Re-index failed:** re-indexing a GitHub repo failed with "destination path already exists". On Windows, git marks object files read-only, so `shutil.rmtree(..., ignore_errors=True)` silently left a half-deleted clone behind.
  - **Incident:** a first fix updated an existing clone in place (`remote set-url` / `fetch` / `reset --hard` / `clean`). The workspace folder (`D:\ArchonAI\workspace\<id>`) lives inside ARCHON's own checkout, and the clone's `.git` was broken. Git discovery therefore walked up to ARCHON's repository and reset its `main` to the fetched commit and repointed its `origin`. It was recovered from the reflog with the owner's go-ahead: `main` back at 0db12f0, `origin` back to github.com/ParamShah77/ArchonAI, `origin/main` back at 53e89c1. Only uncommitted work was lost; it was re-applied.
  - **Graph data:** the review (tier 3) also found wrong graph data. `from pkg import sub` linked to `pkg/__init__.py`, and packages from test-fixture manifests looked like real dependencies.
- **Decision:**
  - `_git(..., ceiling=)` sets `GIT_CEILING_DIRECTORIES` so git never searches at or above the workspace folder.
  - `_refresh_clone` only acts when `<dest>/.git/HEAD` exists and `git rev-parse --show-toplevel` equals the clone folder. Otherwise it removes the folder and clones afresh.
  - `_remove_tree` clears read-only flags (`onexc`) so leftovers are really deleted.
  - A regression test recreates the incident in a temp folder (an outer repo with a broken clone inside it) and asserts that the outer repo's HEAD, remotes and files are untouched.
  - Builder: `from pkg import a, b` links to `pkg/a.py` and `pkg/b.py` when they exist; `@/` aliases fall back to a unique suffix match; dependencies declared only by manifests under test paths get `meta.fixture = true` (`TEST_PATH_RE` moved to `archon/graph/paths.py`).
- **Alternatives considered:**
  - Always delete and re-clone: simple, but re-downloads every time, and deletion was the original failure.
  - Moving the workspace outside the repository: right long-term, but changes the configuration and existing data paths; the ceiling and toplevel check make the location safe either way.
  - `git -C`: still uses discovery, so it does not prevent walking up.
- **Why this one:** two independent guards (git cannot look up, and nothing mutates unless the top level is the clone folder) make the destructive path impossible, while keeping fast in-place refreshes.
- **Consequences:** re-indexing cloned repos works on Windows. Any future git command in workspace clones must go through `_git(..., ceiling=)`. Python package imports now point at the real modules, so `__init__.py` files stop collecting arrows.

## D-031 — Code map, tier 3: Health lens, hover cards, touchable lines, next-step actions, structure order, quiet hubs, a fast canvas, a test safety net
- **Date:** 2026-10-12
- **Status:** Accepted (completes `docs/code-map-plan.md`; amends D-029's layout order and D-026's per-frame merge)
- **Context:** The owner asked to "finish" the plan. Tier 3 and the critic's remaining gaps covered: a Health view, richer facts, lines you can inspect, actions from a node, an order that follows the code's structure, calmer dense files, a crisper and faster canvas, keeping your place, opening the code, and a safety net for a renderer that had broken three times.
- **Decision:**
  - **Health lens** (toolbar `Structure | Health`):
    - Open findings are loaded only when the lens is on.
    - Each node's findings weight (severity × confidence) is rolled up to its folders and divided by KLOC, then placed in five bins: <2, 2–5, 5–8, 8–11, ≥11 per 1,000 lines.
    - Tiles blend over about 350 ms into an OKLCH scale from slate through apricot to rose (chroma ≤ 0.09, no glow). Tiles show a findings mark; symbols get a soft ring.
    - Test code is excluded. The key shows the scale, or "run an analysis on the Audit tab".
  - **Hover cards:** they appear after a 250 ms rest. They show kind, path, size, lines, "imported by N files · imports M" (files) or "used by / uses" (symbols), "a test imports it", findings and the signature, in at most 6 rows. Facts are computed once per model.
  - **Lines you can touch:**
    - Hovering a line shows "A → B · n relationships · kinds · e.g. x → y"; clicking it flies to both ends.
    - Selection lines leaving the screen end in tags like "→ graph · 2" (merged, at most 6 plus "+N more"); clicking a tag flies to both ends and pings.
  - **Actions** (`nodeActions.ts`, shared by the right-click menu and the details panel):
    - Change impact, Generate tests (functions), Refactoring ideas: links to the Tools page.
    - Ask Chat: `?q=` prefills the question without sending it.
    - Copy path.
    - Open in VS Code (`vscode://file/…:line`) for local repositories, or on GitHub at the indexed commit.
    - Shift + right-click keeps the browser's menu.
    - The highlighted search result gets a preview ring and ping without moving the camera.
    - The details panel adds Facts, Findings and "Imported by tests" (tests-intel), and its relationship headings use the map's direction colours.
  - **Structure order:**
    - Inside a folder, boxes are ranked by dependency: users before what they use, longest path over relationships lifted to siblings, cycles broken by path.
    - Tiers: product code, then tests, then the Packages and Other-files groups (also at the top level).
    - Test code is drawn at half chroma.
    - Packages are sorted by ecosystem, then product / dev / fixture, then most used. Dev and fixture packages are outline-only.
    - Nested functions sort after their parent and are drawn 85% high.
    - ORM tables sit in their file, not inside the model class.
    - Empty marker files (no symbols, no relationships, ≤3 lines) are hidden.
    - Files mixing classes and functions also get call-flow layers for their functions. Across ArchonAI, call lines pointing down went 283 → 479 and pointing up 173 → 29.
  - **Calmer dense files:**
    - A hub (called from at least max(5, 30%) of its file's symbols, at most 2 per box) gets quiet incoming lines and a count bubble.
    - Lines meeting one side of a tile or chip are spread over the middle 70% of that side, at least 6 px apart, ordered by destination.
    - Bundled exits were left out (see alternatives).
  - **Crisp and fast:**
    - The canvas context is opaque, and the background is painted at once after a resize.
    - At rest, box edges snap to device pixels and 1 px borders sit on half pixels.
    - Grid dots are 2×2 device pixels drawn as one path (about 3× faster than a fillRect per dot).
    - The per-frame line merge works on integer arrays built once with the model (`eSrc` / `eTgt` / `eKind` / `eExt`, ancestor chains, numeric pair keys). It produces exactly the same pairs (verified 59/59, identical weights), and the merge's JavaScript time fell from about 3 ms to well under 1 ms per frame. Frames are now about 1 ms p50 at rest on ArchonAI.
  - **Keep your place:** the whole-graph payload is cached per repository and version while you visit other tabs. The camera is saved per repository in sessionStorage (after user moves and landed flights) and restored when the layout key matches.
  - **Safety net:** Vitest (`npm test`) covers:
    - view-model rules;
    - layout (no sibling overlaps; callers above or beside callees, also next to classes);
    - model arrays and file facts;
    - palette contrast (every text ≥ 4.5:1 on every surface, closed tile ≥ 1.4× its surface, chips ≥ 7:1);
    - text fitting.
- **Alternatives considered:**
  - Bundled exits through parent ports: kept out; the plan marked it optional, and the spread ports plus the budget already removed the pile-ups.
  - A pattern-filled dot grid: about 0 ms, but integer tile sizes make the dots drift and jump while zooming.
  - Loading findings always: an extra request on every map visit for a view most visits do not use.
  - A minimap and always-on badges: rejected earlier as clutter.
  - Jest instead of Vitest: Vitest runs TS/ESM directly with the same config style as the app.
- **Why this one:** each item answers a concrete gap from the review or the critic while keeping the calm look. The performance work makes the extra features free (frames got faster, not slower).
- **Consequences:**
  - New dev dependency `vitest`.
  - The Health colours depend on a recent analysis run (re-indexing clears findings until the next run).
  - The layout cache key bumped to v5.
  - Moving the map to the right of the screen when a node is selected under the panel remains handled by `ensureVisible`.

## D-032 — Graph view: a Neo4j-style node-link graph beside the Map, with detail that grows as you zoom
- **Date:** 2026-10-17
- **Status:** Accepted. Adds a second view to the Code Map page; the nested-box Map of D-024 to D-031 stays the default.
- **Context:** The owner shared Neo4j Browser screenshots and asked for "this code map". The screenshots show coloured circles per kind, labelled relationship lines with arrows, star clusters, and an overview of labels and relationship types with counts. The owner also asked that "as we zoom in the zoomed part becomes clearer and clearer".
- **Decision:**
  - **Toggle:** a Map | Graph toggle in the Code Map toolbar. The choice is remembered in localStorage and read through `useSyncExternalStore`, so the server render and hydration agree.
  - **Data** (`forceData.ts`):
    - Every node except the repo is a circle coloured by kind (a Neo4j-like palette).
    - Radius is 8–13 by kind plus 1.6·√degree, capped at 26.
    - Every relationship is a line, including `contains`. So a file and its symbols form a star, and folders hold the stars together.
  - **Physics** (d3-force, shared by the worker and the main thread through `makeSimulation`):
    - `contains` links are short and strong.
    - Calls are very weak (0.004) and other relationships weak (0.012). Otherwise the 1,000+ calls knot everything into one even ball.
    - Charge depends on kind: folders −420, files −260, classes −60, symbols −20. Stars stay tight and spread apart.
    - Collision radius is r + 4, with weak centring.
    - Start positions are seeded next to the container, so the same repository settles into the same picture.
  - **Settling in a Web Worker** (`force.worker.ts`):
    - About 200 ticks of a 1,100-node graph cost about 1.5 s of CPU (7 ms per tick measured).
    - The worker ticks in 33 ms slices and streams positions back. The page keeps panning and zooming smoothly, and the camera auto-fits until you touch it.
    - Dragging stops the worker; the live main-thread simulation finishes the settling around your hand.
    - Dropped nodes stay pinned; a double-click releases them.
  - **Detail by zoom** (screen sizes, smooth fades):
    - Tiny circles become 2 px dots.
    - Lines fade with length, so lines between far clusters stay quiet.
    - Hub names (top 6% by degree) appear beside their circles from k ≈ 0.12, and every name from k ≈ 0.55. Collision checks keep them from overlapping.
    - A name moves inside its circle once the circle can hold it whole; it shrinks to 9 px before it is ever shortened. The name beside fades out before the inside one fades in, so there is never a double.
    - Arrows appear from k ≈ 0.35.
    - Relationship types appear along lines from k ≈ 1.2, only on lines shorter than 420 px. They read upright, cut the line, and have collision checks.
    - Selection (or hover) keeps the node, its neighbours and their lines bright, with types shown on those lines from k ≈ 0.5. Everything else dims.
  - **Overview panel** (`GraphOverview.tsx`):
    - Node-label chips and relationship-type chips, each with counts. Click a chip to hide or show it; `*` shows all.
    - "Displaying N nodes, M relationships".
    - Filtering keeps the current positions and nudges the layout.
  - The Graph view implements `MapController`, so Fit all, search (fly and preview ring), the zoom controls and the details panel work unchanged.
- **Alternatives considered:**
  - **Replacing the Map:** the nested map answers "where is it" and "what is inside" at a glance; the graph answers "how is it connected". Both stay, one toggle apart.
  - **A graph library** (Cytoscape, sigma.js, react-force-graph): heavier, and harder to style to the app's look and to drive with the existing camera and controller. d3-force is about 15 kB, and the renderer reuses the map's text and palette helpers.
  - **WebGL:** Canvas2D draws 1,100 nodes and 2,500 lines well within a frame here. WebGL would add a dependency and lose crisp canvas text.
  - **Ticking on the main thread only:** settling was tied to the frame rate (a throttled tab took minutes) and cost about 7 ms per frame.
  - **Hiding calls by default:** a simpler picture, but it hides the most useful relationship. Weak call forces give the same calm layout with all lines shown.
- **Why this one:** it matches the reference closely (circles, colours, stars, typed arrows, an overview with counts) while keeping ARCHON's dark, soft look. It delivers "clearer and clearer" with a fixed order of detail driven by on-screen size.
- **Consequences:**
  - New dependencies `d3-force` and `@types/d3-force`.
  - Positions are cached in memory per repository version, not across reloads. A reload settles again in about 1–2 s, deterministically.
  - Very large repositories (10k+ nodes) would need sampling or clustering before the graph stays readable. The current repositories do not need it.

## D-033 — Homepage: one entry per repository, cards with a summary, most recently used first
- **Date:** 2026-10-18
- **Status:** Accepted
- **Context:** The owner asked for a more refined homepage. Two problems stood out:
  - The repository list was a plain list that did not use what ARCHON already knows.
  - Adding the same folder twice had created two "ArchonAI" entries. The chats and docs were on one entry, and the fresh graph and findings on the other.
- **Decision:**
  - **One entry per repository:**
    - `POST /repos` compares `source_key(source)`. Git URLs are normalised: `.git` and trailing slashes dropped, lower case, scp form and user@ removed. Local paths are resolved and case-folded on Windows.
    - A match returns the existing entry and re-analyzes it (unless it is already running), instead of creating a duplicate. The page says "already here, refreshing it".
    - Names of local folders are taken from the last path part with either separator.
  - **List summary:** `GET /repos` adds `summary` to each repository:
    - latest health score and grade;
    - open findings by severity;
    - last finished analysis run;
    - number of conversations;
    - last activity, the latest of the update, the analysis run and the newest conversation.
    - These come from stored rows in four grouped queries; nothing is computed or analyzed. The list is sorted by last activity.
  - **Page:**
    - A one-line explanation of ARCHON, then the add box. The box shows a git or folder icon depending on what you type.
    - Repository cards in two columns. Each card shows:
      - the source in short form (`github.com/org/repo`, `~\Desktop\x`);
      - a language bar in GitHub's language colours, plus frameworks;
      - files, lines and symbols;
      - the health grade (only once an audit has run, because a score computed without findings would mislead);
      - open findings with severity dots;
      - shortcuts to Overview, Map, Chat (with the conversation count), Audit and Tools;
      - "updated N ago";
      - a ⋯ menu with Re-analyze and Remove (the confirmation names what is lost).
    - Running analyses show progress text. Failures show the error.
    - A filter box appears from 4 repositories.
    - A three-step welcome appears when there are none.
  - The header's API and LLM chips are removed (owner's request). The header shows a chip only when the API is offline or no AI provider is configured.
- **Alternatives considered:**
  - A unique database constraint on the source: raw strings differ for the same repository (slashes, case, `.git`), and existing databases already hold duplicates that would block the migration.
  - Rejecting a duplicate add with an error: re-adding is a natural way to say "update this", so refreshing is friendlier.
  - Fetching each card's health with its own request: N extra requests on every visit and every 1.5 s poll while something runs.
- **Why this one:** the home page now answers "what is here, how healthy is it, what changed recently, where do I go next" without extra requests, and the same repository can no longer split its history across two entries.
- **Consequences:**
  - `RepoOut.summary` is optional and is filled only by the list endpoint.
  - The duplicate "ArchonAI" entry already in the database needs a one-off merge: move its conversations and documents to the newer entry, then remove the old one. This step waits for the owner's approval.

## D-034 — Workflow round: automatic audit, health trend, freshness, quick jump, repo switcher, tool history, streaming chat
- **Date:** 2026-10-18
- **Status:** Accepted
- **Context:** The owner asked for nine follow-ups from the homepage review. Most repositories showed "not audited yet". The npm audit listed 10 advisories. There was no way to see whether health improves, whether a repository changed since its analysis, to jump anywhere quickly, to switch repositories in place, to reopen a tool's result, or to watch a chat answer arrive.
- **Decision:**
  - **Automatic audit:**
    - `ingest_repository` runs every static analyzer (an `AnalysisRun`, then a health snapshot) right after indexing.
    - It makes no AI calls and takes seconds.
    - The `ARCHON_AUTO_ANALYZE` setting (default on) turns it off.
  - **Health trend:**
    - `RepoSummary.health_history` holds the last 12 scores.
    - Each card draws a 44 px line, green if the score went up, rose if down, grey if flat.
  - **Freshness:**
    - Ingestion stores `stats.fingerprint`, a SHA-1 of (path, size, mtime) for every scanned file. It uses stat calls only, no reads.
    - `GET /repos/freshness` compares:
      - local folders: against a fresh fingerprint;
      - git URLs: the analyzed commit against `git ls-remote` with an 8 s timeout and no credential prompt.
    - `changed` is null when it cannot tell. Results are cached for 60 s, and the cache is cleared on re-analysis.
    - The homepage asks once per visit. Cards then show "Changed · re-analyze" in place of the age.
  - **Quick jump** (`CommandPalette.tsx`, Ctrl/⌘ + K or the "Jump to…" button):
    - Covers sections of the current repository, every tool (deep link `?tool=`), other repositories, any file, function or endpoint (graph search, opening the map on that node), and "Add a repository".
    - Uses subsequence matching with word-start bonuses, and full keyboard control.
    - It is mounted by the home page and RepoShell rather than the root layout, so the owner's uncommitted layout change is untouched. Those are the only two page shells.
  - **Repository switcher:** the name in the repository header opens a list of repositories. Picking one keeps the current tab and drops the old repository's query string.
  - **Tool history:**
    - New `tool_runs` table with tool, title, trimmed inputs (≤ 20k characters per field) and the JSON result.
    - Every Tools endpoint saves its run and returns `run_id`. The newest 30 per tool and repository are kept.
    - `GET/DELETE /repos/{id}/tool-runs[/{run_id}]`.
    - The Tools page shows "Recent runs". Opening one restores the result and puts its input back in the form.
  - **Streaming chat:**
    - `LLMProvider.stream()`:
      - native for Groq and xAI (OpenAI-compatible `stream=True`) and Gemini (`generate_content_stream`);
      - one piece for providers without native streaming.
    - `FallbackChain.stream()` tries links until one produces its first piece within the timeout. From then on the answer stays with that link, and a later failure ends it with a note.
    - `POST /repos/{id}/chat/stream` returns NDJSON events: `sources`, `delta`… then `done`.
    - Reads happen before the response starts. Messages are saved with a fresh session at the end, because FastAPI closes the request session before a streamed body runs.
    - The chat UI renders the answer as it grows.
  - **Citations open the map** (`chat/citations.ts`): these become links to the cited node (when lines match) or to the file (`?prefix=`):
    - `[path:lines]` with any dash style;
    - `` `path:lines` `` in backticks;
    - plain mentions of a cited file's name.
    - Code blocks are left alone.
  - **npm advisories:** 10 → 5.
    - `npm audit fix` updated sharp and source-map-js.
    - Vitest went 3 → 5 (dev only), which closed the critical tinypool and the vitest/mocker advisories. `@types/node` went to 22 to match.
    - The remaining 5 (high) are one chain, `eslint-config-next → fast-glob → micromatch → braces`. They run only while linting our own files. No patched `braces` exists, and npm's "fix" would downgrade the Next 16 lint config to 14, so it is left until upstream ships a fix.
- **Alternatives considered:**
  - Tool history in localStorage: lost on another browser, and inputs like logs can be megabytes.
  - Server-Sent Events for chat: NDJSON over a POST fetch is simpler (no EventSource GET limits) and carries the same events.
  - Streaming by re-chunking a finished answer: no faster first word, so no real benefit.
  - Watching folders for changes (file watchers): constant cost and platform quirks; a fingerprint checked on visit is enough.
  - Mounting the palette in the root layout: cleaner, but it would have mixed with the owner's uncommitted layout edit.
- **Why this one:** each item removes a step the owner had to take by hand (open Audit, compare scores, guess staleness, navigate, re-run a tool, wait for a whole answer) using data ARCHON already has, with small, testable pieces.
- **Consequences:**
  - Ingestion takes a few seconds longer while it audits.
  - New table `tool_runs`, created by `create_all` at startup.
  - `/repos/freshness` may take up to 8 s for unreachable remotes. It is only called once per homepage visit.
  - The non-streaming `POST /chat` stays for API users and tests.

## D-035 — A real website at `/`, the app at `/repos`; no provider or model names anywhere in the interface
- **Date:** 2026-10-18
- **Status:** Accepted (moves the repository list of D-033 to `/repos`)
- **Context:** The owner wants the home page to work like a product website ("first only about ARCHON, and then we get in the app"). The owner also wants no AI provider or model names shown anywhere.
- **Decision:**
  - **Routes:** `/` is a static landing page. The repository list moved to `/repos`. Every link that meant "the list" now points there: header, breadcrumb, switcher, quick jump, and "Add a repository" (`/repos?add=1` focuses the add box).
  - **Landing page** (`app/page.tsx`, no data or requests), in this order:
    - a hero with a drawn product preview (a code map and a streaming answer with citations; plain elements, no screenshots);
    - the three questions ARCHON answers;
    - six features;
    - how it works in three steps;
    - eight tools;
    - three trust points (runs locally, read-only folders, facts before AI);
    - a closing call to action and a footer.
    - It uses the app's own tokens and dark palette. Motion is two fade-ups and a blinking caret, switched off with `prefers-reduced-motion`. It fits a phone without sideways scrolling.
  - **One header** (`SiteHeader.tsx`): on `/` it is the website's navigation (Features, How it works, Tools, "Open ARCHON"). Elsewhere it is the app bar (Repositories plus the problem-only status chip).
  - **No provider or model names in the interface:**
    - The chat no longer shows "answered by …". The Tools and Overview pages no longer show the model.
    - Errors people see come from `archon.llm.public_error()`. It says either "AI answers are not set up on this server yet…" or "The AI service did not answer this time…".
    - Raw provider errors go only to the server log.
    - Saved architecture reports are cleaned when served.
    - The API still returns `answered_by` and `ai_model` for diagnostics, but the web app does not render them.
  - **Health trend:** it now counts only scores recorded at or after a repository's first audit. A score computed before any audit has no findings and faked a drop.
- **Alternatives considered:**
  - Keeping the list at `/` with a hero above it: it mixes the website and the app, which is what the owner asked to separate.
  - A separate marketing site: a second deployment for one page.
  - Screenshots in the hero: they go stale with every UI change and are heavy. A drawn preview stays sharp and current.
  - Hiding the provider in the API too: the diagnostics (`/health` chain status, `answered_by`) are useful to operators and are never shown to people.
- **Why this one:** a newcomer first learns what ARCHON is and why it helps, then enters the app with one click. The interface talks about "AI" as one capability, not about vendors.
- **Consequences:**
  - Bookmarks to `/` now land on the website (one click to the app).
  - The owner's uncommitted font change in `layout.tsx` was left unstaged. Only the header swap was committed.
