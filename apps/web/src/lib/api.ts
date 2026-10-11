/**
 * Typed client for the ARCHON API. Mirrors apps/api/archon/api/schemas.py.
 * The base URL comes from NEXT_PUBLIC_ARCHON_API_URL (apps/web/.env.local) and
 * falls back to the API's default bind address.
 */
export const API_URL = process.env.NEXT_PUBLIC_ARCHON_API_URL ?? "http://127.0.0.1:8001";
const API_KEY = process.env.NEXT_PUBLIC_ARCHON_API_KEY ?? "";

export type RepoStatus = "pending" | "ingesting" | "ready" | "failed";

export interface Repo {
  id: string;
  name: string;
  source: string;
  status: RepoStatus;
  error: string;
  default_branch: string;
  commit_sha: string;
  stats: Record<string, unknown> & {
    files?: number;
    lines?: number;
    nodes?: number;
    edges?: number;
    languages?: Record<string, number>;
    parse_errors?: string[];
    analysis_seconds?: number;
  };
  stack: {
    languages?: { name: string; files: number; share: number }[];
    primary_language?: string;
    frameworks?: string[];
    databases?: string[];
    auth?: string[];
    infra?: string[];
    ci?: string[];
    ai?: string[];
    testing?: string[];
    tooling?: string[];
    package_managers?: string[];
    dependency_count?: number;
  };
  created_at: string;
  updated_at: string;
}

export type NodeKind =
  | "repo" | "directory" | "file" | "module" | "class" | "function" | "method" | "endpoint" | "table" | "dependency";
export type EdgeKind =
  | "contains" | "imports" | "calls" | "extends" | "implements" | "exposes" | "queries" | "depends_on";
export type GraphLevel = "system" | "file" | "symbol" | "all";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  path: string;
  qualified_name: string;
  language: string;
  start_line: number;
  end_line: number;
  meta: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  meta: Record<string, unknown> & { weight?: number };
}

export interface Graph {
  level: GraphLevel;
  focus: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Neighbor {
  node: GraphNode;
  edge_kind: EdgeKind;
  direction: "in" | "out";
  meta: Record<string, unknown>;
}

export interface NodeDetail {
  node: GraphNode;
  file: GraphNode | null;
  parent: GraphNode | null;
  source: string | null;
  neighbors: Neighbor[];
}

export interface Metrics {
  files: number;
  functions: number;
  classes: number;
  endpoints: number;
  tables: number;
  dependencies: number;
  most_imported: { path: string; fan_in: number }[];
  most_importing: { path: string; fan_out: number }[];
  import_cycles: string[][];
}

export interface ArchitectureComponent {
  name: string;
  layer: string;
  files: number;
  classes: number;
  functions: number;
  endpoints: number;
  tables: number;
  imports_from: Record<string, number>;
}

export interface ArchitectureAI {
  summary: string;
  architecture_style: string;
  components: { name: string; responsibility: string; paths: string[]; layer: string }[];
  data_flow: string[];
  external_systems: string[];
  risks: string[];
  mermaid?: string;
}

export interface ArchitectureReport {
  repo: string;
  stack: Repo["stack"];
  components: ArchitectureComponent[];
  entry_points: string[];
  endpoints: string[];
  endpoint_count: number;
  tables: string[];
  metrics: Metrics;
  ai: ArchitectureAI | null;
  ai_error?: string;
  ai_model?: string | null;
}

export interface LlmLink {
  link: string;
  ok: number;
  failed: number;
  last_error: string;
  last_latency_s: number;
  cooling_down: boolean;
  tpm_limit?: number;
  otpm_limit?: number;
  recovered_json?: number;
}

export interface Health {
  status: string;
  version: string;
  llm_provider: string;
  llm_configured: boolean;
  llm_chain: LlmLink[];
  embeddings: boolean;
  database: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(API_KEY ? { "X-API-Key": API_KEY } : {}), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ---------------------------------------------------------------- Phase 2-4 types
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export interface Finding {
  id: string;
  analyzer: string;
  category: string;
  severity: Severity;
  title: string;
  description: string;
  path: string;
  start_line: number;
  end_line: number;
  node_id: string;
  evidence: string;
  recommendation: string;
  confidence: number;
  tags: string[];
  status: "open" | "resolved" | "dismissed";
  created_at: string;
}
export interface FindingsResponse {
  count: number;
  summary: Record<string, Record<string, number>>;
  findings: Finding[];
}
export interface AnalysisRun {
  id: string;
  analyzers: string[];
  status: "pending" | "running" | "done" | "failed";
  error: string;
  summary: Record<string, { findings?: number; error?: string; score?: number; grade?: string }>;
  started_at: string;
  finished_at: string | null;
}
export interface HealthScore {
  current: {
    score: number;
    grade: string;
    dimensions: Record<string, number>;
    weights: Record<string, number>;
    finding_counts: Record<string, number>;
    findings_total: number;
    kloc: number;
    test_coverage_ratio: number | null;
    import_cycles: number;
    top_issues: { id: string; title: string; severity: Severity; path: string; analyzer: string }[];
  };
  history: { score: number; created_at: string | null; commit_sha: string; dimensions?: Record<string, number> }[];
}
export interface ApiIntel {
  count: number;
  by_method: Record<string, number>;
  resources: Record<string, number>;
  auth_coverage: number | null;
  versioned: boolean;
  endpoints: {
    id: string; method: string; route: string; path: string; line: number; handler: string; handler_id: string;
    params: string; path_params: string[]; auth: boolean; reaches_tables: string[]; calls: string[]; depth: number; resource: string;
  }[];
}
export interface DbIntel {
  tables: { id: string; name: string; path: string; line: number; columns: string[]; references: string[]; models: string[]; declared_in: string[]; accessed_by: { name: string; path: string; id: string }[]; access_count: number; orm: boolean; has_pk: boolean | null }[];
  relationships: { from: string; to: string }[];
  migrations: string[];
  raw_sql_sites: { path: string; line: number; text: string }[];
  raw_sql_count: number;
  engines: string[];
  table_count: number;
  orm_tables: number;
}
export interface DepRow { name: string; ecosystem: string; version: string; dev: boolean; manifest: string; importers: number; files: string[]; node_id: string; reason?: string; severity?: string }
export interface DepsIntel {
  total: number; ecosystems: string[]; inventory: DepRow[]; unused: DepRow[]; risky: DepRow[]; unpinned: DepRow[]; hubs: DepRow[];
  undeclared: { ecosystem: string; module: string; files: string[] }[]; dev_count: number;
}
export interface TestsIntel {
  test_files: number; test_cases: number; source_files: number; covered_files: number; coverage_ratio: number | null;
  untested_files: string[]; frameworks: string[];
  risky_untested: { id: string; name: string; path: string; line: number; score: number; callers: number; endpoint: boolean; queries_db: boolean }[];
  map: Record<string, string[]>;
}
export interface ChatSource { path: string; start_line: number; end_line: number; node_id: string; kind: string; name: string; why: string; score: number }
export interface ChatResponse { conversation_id: string; answer: string; sources: ChatSource[]; answered_by?: string }
export interface ChatMessage { id: string; role: "user" | "assistant"; content: string; sources: ChatSource[]; created_at: string; answered_by?: string }
export interface Conversation { id: string; title: string; created_at: string }
export interface Doc { id: string; kind: string; title: string; subject: string; ai: boolean; created_at: string; content?: string }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export interface AIResult { ai: Json | null; ai_error?: string | null; ai_model?: string | null; facts?: Json; sources?: ChatSource[]; [k: string]: Json }

export const DOC_KINDS = ["architecture", "api", "modules", "dataflow", "database", "dependencies", "setup", "onboarding"];
export const SEVERITY_COLOR: Record<Severity, string> = { critical: "#ff5c7a", high: "#ff7b9c", medium: "#ffb86c", low: "#5aa9ff", info: "#8b93a7" };

export const api = {
  health: () => request<Health>("/health"),
  analysis: {
    analyzers: (id: string) => request<{ name: string; description: string }[]>(`/repos/${id}/analyzers`),
    run: (id: string, analyzers?: string[]) => request<AnalysisRun>(`/repos/${id}/analyze`, { method: "POST", body: JSON.stringify({ analyzers }) }),
    runs: (id: string) => request<AnalysisRun[]>(`/repos/${id}/analysis/runs`),
    findings: (id: string, p: { analyzer?: string; severity?: string; status?: string; path?: string; limit?: number }) => request<FindingsResponse>(`/repos/${id}/findings${qs(p)}`),
    setStatus: (id: string, findingId: string, status: string) => request<Finding>(`/repos/${id}/findings/${findingId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    health: (id: string, recompute = false) => request<HealthScore>(`/repos/${id}/health-score${qs({ recompute: recompute ? "true" : undefined })}`),
    apiIntel: (id: string) => request<ApiIntel>(`/repos/${id}/api-intel`),
    dbIntel: (id: string) => request<DbIntel>(`/repos/${id}/db-intel`),
    deps: (id: string) => request<DepsIntel>(`/repos/${id}/dependencies`),
    tests: (id: string) => request<TestsIntel>(`/repos/${id}/tests-intel`),
  },
  chat: {
    ask: (id: string, question: string, conversation_id?: string | null) => request<ChatResponse>(`/repos/${id}/chat`, { method: "POST", body: JSON.stringify({ question, conversation_id }) }),
    conversations: (id: string) => request<Conversation[]>(`/repos/${id}/conversations`),
    conversation: (id: string, cid: string) => request<{ id: string; title: string; messages: ChatMessage[] }>(`/repos/${id}/conversations/${cid}`),
    reindex: (id: string) => request<{ chunks: number; embedded: number }>(`/repos/${id}/index`, { method: "POST" }),
  },
  docs: {
    list: (id: string) => request<Doc[]>(`/repos/${id}/docs`),
    get: (id: string, docId: string) => request<Doc>(`/repos/${id}/docs/${docId}`),
    generate: (id: string, kinds?: string[]) => request<Doc[]>(`/repos/${id}/docs/generate`, { method: "POST", body: JSON.stringify({ kinds }) }),
  },
  tools: {
    debug: (id: string, error: string, description: string) => request<AIResult>(`/repos/${id}/debug`, { method: "POST", body: JSON.stringify({ error, description }) }),
    impact: (id: string, body: { node_id?: string; path?: string; symbol?: string; depth?: number; change?: string; ai?: boolean }) => request<AIResult>(`/repos/${id}/impact`, { method: "POST", body: JSON.stringify(body) }),
    feature: (id: string, description: string, mode: "simulate" | "plan") => request<AIResult>(`/repos/${id}/feature?mode=${mode}`, { method: "POST", body: JSON.stringify({ description }) }),
    advise: (id: string, question: string) => request<AIResult>(`/repos/${id}/advise`, { method: "POST", body: JSON.stringify({ question }) }),
    refactor: (id: string, body: { node_id?: string; path?: string }) => request<AIResult>(`/repos/${id}/refactor`, { method: "POST", body: JSON.stringify(body) }),
    tests: (id: string, node_id: string) => request<AIResult>(`/repos/${id}/tests/generate`, { method: "POST", body: JSON.stringify({ node_id }) }),
    review: (id: string, diff: string, title: string) => request<AIResult>(`/repos/${id}/review`, { method: "POST", body: JSON.stringify({ diff, title }) }),
    logs: (id: string, logs: string, description: string) => request<AIResult>(`/repos/${id}/logs`, { method: "POST", body: JSON.stringify({ logs, description }) }),
  },
  repos: {
    list: () => request<Repo[]>("/repos"),
    get: (id: string) => request<Repo>(`/repos/${id}`),
    create: (source: string) => request<Repo>("/repos", { method: "POST", body: JSON.stringify({ source }) }),
    reingest: (id: string) => request<Repo>(`/repos/${id}/reingest`, { method: "POST" }),
    remove: (id: string) => request<void>(`/repos/${id}`, { method: "DELETE" }),
  },
  graph: {
    view: (id: string, p: { level?: GraphLevel; focus?: string; depth?: number; kinds?: string; path_prefix?: string }) =>
      request<Graph>(`/repos/${id}/graph${qs(p)}`),
    node: (id: string, nodeId: string) => request<NodeDetail>(`/repos/${id}/nodes/${nodeId}`),
    search: (id: string, q: string, kinds?: string) =>
      request<{ query: string; results: GraphNode[] }>(`/repos/${id}/search${qs({ q, kinds, limit: 20 })}`),
    metrics: (id: string) => request<Metrics>(`/repos/${id}/metrics`),
    architecture: (id: string, refresh = false) =>
      request<ArchitectureReport>(`/repos/${id}/architecture${qs({ refresh: refresh ? "true" : undefined })}`),
  },
};

/** Visual identity of each node kind — shared by the map, badges and the detail panel. */
/**
 * Visual identity of each kind — shared by the map, badges and panels. A soft, low-saturation palette
 * (decisions.md D-024): distinct hues at similar lightness, so nothing shouts on the dark background.
 */
export const KIND_STYLE: Record<NodeKind, { color: string; label: string; shape: string }> = {
  repo: { color: "#dfe4ec", label: "Repository", shape: "round-rectangle" },
  directory: { color: "#9aabc4", label: "Folder", shape: "round-rectangle" },
  file: { color: "#8bc7e5", label: "File", shape: "round-rectangle" }, // oklch(.80 .075 230): distinct from class under deuteranopia
  module: { color: "#8ab9d6", label: "Module", shape: "round-rectangle" },
  class: { color: "#b8a7db", label: "Class", shape: "round-rectangle" },
  function: { color: "#9ccfac", label: "Function", shape: "ellipse" },
  method: { color: "#92c6bf", label: "Method", shape: "ellipse" },
  endpoint: { color: "#e3b993", label: "Endpoint", shape: "round-diamond" },
  table: { color: "#dfa3b1", label: "Table", shape: "barrel" },
  dependency: { color: "#d6cb99", label: "Package", shape: "round-tag" },
};

/** Relationship styles. `dash` is the canvas line-dash pattern in px at width 1 (the map scales it). */
export const EDGE_STYLE: Record<EdgeKind, { color: string; style: "solid" | "dashed" | "dotted"; dash: number[]; label: string }> = {
  contains: { color: "#4a5265", style: "solid", dash: [], label: "contains" },
  imports: { color: "#8aa4c6", style: "solid", dash: [], label: "imports" },
  calls: { color: "#94c2a3", style: "solid", dash: [], label: "calls" },
  extends: { color: "#ad9fd0", style: "dashed", dash: [6, 4], label: "extends" },
  implements: { color: "#ad9fd0", style: "dotted", dash: [1.5, 3.5], label: "implements" },
  exposes: { color: "#d6b08f", style: "dashed", dash: [2, 4], label: "exposes" },
  queries: { color: "#d39ca9", style: "dashed", dash: [3, 3], label: "queries" },
  depends_on: { color: "#c8bf92", style: "dotted", dash: [1.5, 5], label: "depends on" },
};
