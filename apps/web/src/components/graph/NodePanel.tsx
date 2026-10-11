"use client";

import { ArrowDownLeft, ArrowUpRight, Crosshair, X } from "lucide-react";
import { api, EDGE_STYLE, KIND_STYLE, type EdgeKind, type NodeDetail } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { KindBadge, Spinner } from "@/components/ui";

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
          <button className="btn btn-ghost px-2" title="Focus neighborhood" onClick={() => onFocus(nodeId)}><Crosshair size={15} /></button>
          <button className="btn btn-ghost px-2" title="Close" onClick={onClose}><X size={15} /></button>
        </div>
      </div>
      {loading && !data && <div className="p-4 flex items-center gap-2 text-muted"><Spinner /> Loading…</div>}
      {error && <div className="p-4 text-danger text-sm">{error}</div>}
      {data && <Detail d={data} onSelect={onSelect} />}
    </aside>
  );
}

function Detail({ d, onSelect }: { d: NodeDetail; onSelect: (id: string) => void }) {
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
            {String(n.meta.ecosystem)} {n.meta.version ? String(n.meta.version) : ""} {n.meta.dev ? "(dev)" : ""}
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
      </div>

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
              <div className="flex items-center gap-1.5 stat-label mb-1.5" style={{ color: EDGE_STYLE[kind].color }}>
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
