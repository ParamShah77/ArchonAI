/**
 * Typed client for the ARCHON API. Mirrors apps/api/archon/api/schemas.py.
 * The base URL comes from NEXT_PUBLIC_ARCHON_API_URL (apps/web/.env.local) and
 * falls back to the API's default bind address.
 */
export const API_URL = process.env.NEXT_PUBLIC_ARCHON_API_URL ?? "http://127.0.0.1:8000";

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
export type GraphLevel = "system" | "file" | "symbol";

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
}

export interface Health {
  status: string;
  version: string;
  llm_provider: string;
  llm_configured: boolean;
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
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
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

export const api = {
  health: () => request<Health>("/health"),
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
export const KIND_STYLE: Record<NodeKind, { color: string; label: string; shape: string }> = {
  repo: { color: "#f5f5f5", label: "Repository", shape: "round-rectangle" },
  directory: { color: "#8b93a7", label: "Directory", shape: "round-rectangle" },
  file: { color: "#5aa9ff", label: "File", shape: "round-rectangle" },
  module: { color: "#5aa9ff", label: "Module", shape: "round-rectangle" },
  class: { color: "#c792ea", label: "Class", shape: "hexagon" },
  function: { color: "#7ee0a0", label: "Function", shape: "ellipse" },
  method: { color: "#4ec9b0", label: "Method", shape: "ellipse" },
  endpoint: { color: "#ffb86c", label: "Endpoint", shape: "diamond" },
  table: { color: "#ff7b9c", label: "Table", shape: "barrel" },
  dependency: { color: "#e6db74", label: "Dependency", shape: "tag" },
};

export const EDGE_STYLE: Record<EdgeKind, { color: string; style: "solid" | "dashed" | "dotted"; label: string }> = {
  contains: { color: "#3a4152", style: "solid", label: "contains" },
  imports: { color: "#5aa9ff", style: "solid", label: "imports" },
  calls: { color: "#7ee0a0", style: "solid", label: "calls" },
  extends: { color: "#c792ea", style: "dashed", label: "extends" },
  implements: { color: "#c792ea", style: "dotted", label: "implements" },
  exposes: { color: "#ffb86c", style: "dashed", label: "exposes" },
  queries: { color: "#ff7b9c", style: "dashed", label: "queries" },
  depends_on: { color: "#e6db74", style: "dotted", label: "depends on" },
};
