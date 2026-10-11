"use client";

import { useRouter } from "next/navigation";
import { ArrowDownLeft, ArrowUpRight, Copy, Crosshair, ExternalLink, FlaskConical, MessageSquare, Radar, Wrench, X } from "lucide-react";
import { api, EDGE_STYLE, KIND_STYLE, SEVERITY_COLOR, type EdgeKind, type NodeDetail } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { KindBadge, Spinner } from "@/components/ui";
import type { NodeAction } from "./MapCanvas";
import { editorHref, editorLabel, runAction } from "./nodeActions";

interface Props {
  repoId: string;
  nodeId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onFocus: (id: string) => void;
}

const ORDER: EdgeKind[] = ["exposes", "calls", "imports", "extends", "implements", "queries", "depends_on", "contains"];

export function NodePanel({ repoId, nodeId, onClose, onSelect, onFocus }: Props) {
  const { data, error, loading } = useApi(`node:${repoId}:${nodeId}`, () => api.graph.node(repoId, nodeId));

  return (
    <aside className="h-full w-full border-l border-line bg-elev flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="text-xs text-faint uppercase tracking-wider">Node</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="btn btn-ghost px-2" title="Show it on the map" onClick={() => onFocus(nodeId)}><Crosshair size={15} /></button>
          <button className="btn btn-ghost px-2" title="Close (Esc)" onClick={onClose}><X size={15} /></button>
        </div>
      </div>
      {loading && !data && <div className="p-4 flex items-center gap-2 text-muted"><Spinner /> Loading…</div>}
      {error && <div className="p-4 text-danger text-sm">{error}</div>}
      {data && <Detail d={data} repoId={repoId} onSelect={onSelect} />}
    </aside>
  );
}

/** One-click next steps (the same as the map's right-click menu). */
function Actions({ d }: { d: NodeDetail }) {
  const { repo } = useRepo();
  const router = useRouter();
  const n = d.node;
  const callable = n.kind === "function" || n.kind === "method";
  const items: [NodeAction, string, React.ReactNode][] = [
    ["impact", "Change impact", <Radar key="i" size={14} />],
    ...(callable ? ([["tests", "Generate tests", <FlaskConical key="t" size={14} />]] as [NodeAction, string, React.ReactNode][]) : []),
    ["refactor", "Refactoring ideas", <Wrench key="r" size={14} />],
    ["chat", "Ask Chat about it", <MessageSquare key="c" size={14} />],
    ["copy", "Copy path", <Copy key="p" size={14} />],
    ...(editorHref(repo, n.path, n.start_line) ? ([["open", editorLabel(repo), <ExternalLink key="o" size={14} />]] as [NodeAction, string, React.ReactNode][]) : []),
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([kind, label, icon]) => (
        <button key={kind} className="btn btn-ghost px-2 py-1 text-xs" title={label} onClick={() => runAction(kind, repo, n, (href) => router.push(href))}>
          {icon}
          <span className="hidden xl:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

function Detail({ d, repoId, onSelect }: { d: NodeDetail; repoId: string; onSelect: (id: string) => void }) {
  const n = d.node;
  const grouped = new Map<string, NodeDetail["neighbors"]>();
  for (const nb of d.neighbors) {
    const key = `${nb.direction}:${nb.edge_kind}`;
    grouped.set(key, [...(grouped.get(key) ?? []), nb]);
  }
  const keys = [...grouped.keys()].sort((a, b) => {
    const [da, ka] = a.split(":");
    const [db, kb] = b.split(":");
    return ORDER.indexOf(ka as EdgeKind) - ORDER.indexOf(kb as EdgeKind) || da.localeCompare(db);
  });
  const params = typeof n.meta.params === "string" ? n.meta.params : "";
  const lines = n.end_line > 0 ? n.end_line - Math.max(1, n.start_line) + 1 : 0;
  const filesIn = new Set(d.neighbors.filter((x) => x.direction === "in" && x.edge_kind !== "contains").map((x) => x.node.path)).size;
  const filesOut = new Set(d.neighbors.filter((x) => x.direction === "out" && x.edge_kind !== "contains").map((x) => x.node.path)).size;

  return (
    <div className="overflow-y-auto min-h-0 flex-1">
      <div className="p-4 border-b border-line space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <KindBadge kind={n.kind} />
          {n.language && <span className="chip">{n.language}</span>}
          {typeof n.meta.async === "boolean" && n.meta.async && <span className="chip">async</span>}
          {typeof n.meta.exported === "boolean" && n.meta.exported && <span className="chip">exported</span>}
        </div>
        <h3 className="font-semibold text-base break-all mono">
          {n.name}
          {params && <span className="text-muted font-normal">{params.length > 60 ? params.slice(0, 60) + "…" : params}</span>}
        </h3>
        {n.path && (
          <div className="text-xs text-faint mono break-all">
            {n.path}
            {n.start_line > 0 && <span className="text-muted">:{n.start_line}{n.end_line > n.start_line ? `–${n.end_line}` : ""}</span>}
          </div>
        )}
        {n.kind === "dependency" && (
          <div className="text-xs text-muted mono">
            {String(n.meta.ecosystem)} {n.meta.version ? String(n.meta.version) : ""} {n.meta.dev ? "(dev)" : ""} {n.meta.fixture ? "(test fixture)" : ""}
          </div>
        )}
        {n.kind === "table" && Array.isArray(n.meta.columns) && n.meta.columns.length > 0 && (
          <div className="text-xs text-muted mono">columns: {(n.meta.columns as string[]).join(", ")}</div>
        )}
        {Array.isArray(n.meta.decorators) && n.meta.decorators.length > 0 && (
          <div className="text-xs text-muted mono">{(n.meta.decorators as string[]).join(" ")}</div>
        )}
        {Array.isArray(n.meta.annotations) && n.meta.annotations.length > 0 && (
          <div className="text-xs text-muted mono">{(n.meta.annotations as string[]).join(" ")}</div>
        )}
        <Actions d={d} />
      </div>

      {/* facts at a glance */}
      <div className="px-4 py-3 border-b border-line grid grid-cols-3 gap-2 text-xs">
        <Fact label="lines" value={lines || "—"} />
        <Fact label="used from" value={`${filesIn} file${filesIn === 1 ? "" : "s"}`} />
        <Fact label="uses" value={`${filesOut} file${filesOut === 1 ? "" : "s"}`} />
      </div>

      {n.path && n.kind !== "dependency" && <Findings repoId={repoId} path={n.path} nodeId={n.id} start={n.start_line} end={n.end_line} folder={n.kind === "directory"} />}
      {n.path && n.kind !== "directory" && n.kind !== "dependency" && <TestedBy repoId={repoId} path={n.path} />}

      {d.source && (
        <div className="border-b border-line">
          <div className="px-4 pt-3 stat-label">Source</div>
          <pre className="mono text-[11px] leading-relaxed text-muted p-4 overflow-x-auto max-h-72 whitespace-pre">
            {d.source}
          </pre>
        </div>
      )}

      <div className="p-4 space-y-4">
        {keys.length === 0 && <div className="text-sm text-faint">No relationships.</div>}
        {keys.map((k) => {
          const [dir, kind] = k.split(":") as ["in" | "out", EdgeKind];
          const items = grouped.get(k)!;
          return (
            <div key={k}>
              {/* the map's direction colours: amber = it uses, periwinkle = used by */}
              <div className="flex items-center gap-1.5 stat-label mb-1.5" style={{ color: dir === "out" ? "#f5d9a8" : "#b9c3f5" }}>
                {dir === "out" ? <ArrowUpRight size={12} /> : <ArrowDownLeft size={12} />}
                {dir === "out" ? EDGE_STYLE[kind].label : `${EDGE_STYLE[kind].label} by`} · {items.length}
              </div>
              <ul className="space-y-0.5">
                {items.slice(0, 40).map((nb) => (
                  <li key={nb.node.id}>
                    <button className="w-full text-left flex items-center gap-2 rounded px-2 py-1 hover:bg-elev2 text-xs" onClick={() => onSelect(nb.node.id)}>
                      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: KIND_STYLE[nb.node.kind].color }} />
                      <span className="mono truncate">{nb.node.kind === "method" && nb.node.meta.class ? `${nb.node.meta.class}.` : ""}{nb.node.name}</span>
                      <span className="text-faint truncate ml-auto">{nb.node.path.split("/").pop()}</span>
                    </button>
                  </li>
                ))}
                {items.length > 40 && <li className="text-xs text-faint px-2">… {items.length - 40} more</li>}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-elev2 px-2 py-1.5">
      <div className="text-faint">{label}</div>
      <div className="text-fg mono">{value}</div>
    </div>
  );
}

/** Open findings in this node (a symbol: its own and those inside its lines; a file or folder: all of them). */
function Findings({ repoId, path, nodeId, start, end, folder }: { repoId: string; path: string; nodeId: string; start: number; end: number; folder: boolean }) {
  const { data, loading } = useApi(`findings:${repoId}:${path}`, () => api.analysis.findings(repoId, { path, status: "open", limit: 200 }));
  if (loading && !data) return null;
  const all = (data?.findings ?? []).filter((f) => (folder ? true : f.path === path));
  const list = start > 0 && end > 0 && !folder ? all.filter((f) => f.node_id === nodeId || (f.start_line >= start && f.start_line <= end)) : all;
  return (
    <div className="px-4 py-3 border-b border-line">
      <div className="stat-label mb-1.5">Findings · {list.length}</div>
      {list.length === 0 && <div className="text-xs text-faint">None open{data ? "" : " (run an analysis on the Audit tab)"}.</div>}
      <ul className="space-y-1">
        {list.slice(0, 6).map((f) => (
          <li key={f.id} className="text-xs flex items-start gap-2">
            <span className="mt-1 h-1.5 w-1.5 rounded-full shrink-0" style={{ background: SEVERITY_COLOR[f.severity] }} />
            <span className="text-muted">
              <span className="text-fg">{f.title}</span> <span className="text-faint">· {f.severity}{f.start_line ? ` · L${f.start_line}` : ""}</span>
            </span>
          </li>
        ))}
        {list.length > 6 && <li className="text-xs text-faint">… {list.length - 6} more on the Audit tab</li>}
      </ul>
    </div>
  );
}

/** Test files that import this file (a heuristic from imports, not coverage). */
function TestedBy({ repoId, path }: { repoId: string; path: string }) {
  const { data } = useApi(`tests-intel:${repoId}`, () => api.analysis.tests(repoId));
  if (!data) return null;
  const tests = data.map[path] ?? [];
  return (
    <div className="px-4 py-3 border-b border-line">
      <div className="stat-label mb-1.5">Imported by tests · {tests.length}</div>
      {tests.length === 0 ? (
        <div className="text-xs text-faint">No test file imports it.</div>
      ) : (
        <ul className="space-y-0.5">
          {tests.slice(0, 5).map((t) => (
            <li key={t} className="text-xs mono text-muted truncate">{t}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
