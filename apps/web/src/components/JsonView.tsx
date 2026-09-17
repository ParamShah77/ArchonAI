"use client";

import type { Json } from "@/lib/api";

/**
 * Renders arbitrary structured AI/fact output readably: objects become titled sections, arrays of
 * objects become cards, arrays of primitives become lists, long/multiline strings become code blocks.
 */
const CODE_KEYS = new Set(["code", "patch", "mermaid", "diff", "snippet", "before", "after", "example", "raw"]);
const HIDE_KEYS = new Set(["mock", "id", "node_id", "handler_id"]);

function title(k: string) {
  return k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function Prim({ v, k }: { v: Json; k?: string }) {
  if (v === null || v === undefined) return <span className="text-faint">—</span>;
  if (typeof v === "boolean") return <span className={v ? "text-ok" : "text-faint"}>{v ? "yes" : "no"}</span>;
  if (typeof v === "number") return <span className="mono">{Number.isInteger(v) ? v : v.toFixed(2)}</span>;
  const s = String(v);
  if ((k && CODE_KEYS.has(k)) || s.includes("\n")) return <pre className="mono text-[11px] bg-bg border border-line rounded-md p-3 overflow-x-auto whitespace-pre leading-relaxed">{s}</pre>;
  return <span className="text-fg/90">{s}</span>;
}

export function JsonView({ data, depth = 0 }: { data: Json; depth?: number }) {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-faint text-sm">none</span>;
    if (data.every((x) => typeof x !== "object" || x === null))
      return <ul className="list-disc pl-5 space-y-0.5 text-sm">{data.map((x, i) => <li key={i}><Prim v={x} /></li>)}</ul>;
    return (
      <div className="space-y-2">
        {data.map((x, i) => (
          <div key={i} className="card p-3 bg-elev2/60">
            <JsonView data={x} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof data === "object") {
    const entries = Object.entries(data).filter(([k, v]) => !HIDE_KEYS.has(k) && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
    if (entries.length === 0) return <span className="text-faint text-sm">empty</span>;
    return (
      <div className={depth === 0 ? "space-y-4" : "space-y-2"}>
        {entries.map(([k, v]) => {
          const isObj = typeof v === "object";
          const short = !isObj && String(v).length < 60 && !String(v).includes("\n");
          return (
            <div key={k} className={short ? "flex items-baseline gap-2 text-sm" : ""}>
              <div className={depth === 0 ? "stat-label mb-1" : "text-[11px] uppercase tracking-wider text-faint mb-0.5"}>{title(k)}</div>
              {isObj ? <JsonView data={v} depth={depth + 1} /> : <Prim v={v} k={k} />}
            </div>
          );
        })}
      </div>
    );
  }
  return <Prim v={data} />;
}
