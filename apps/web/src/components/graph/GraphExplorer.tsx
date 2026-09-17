"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Home, Search } from "lucide-react";
import { api, EDGE_STYLE, KIND_STYLE, type GraphLevel, type GraphNode, type NodeKind } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { NodePanel } from "@/components/graph/NodePanel";
import { ErrorBox, KindBadge, Spinner } from "@/components/ui";

const LEVELS: { id: GraphLevel; label: string; hint: string }[] = [
  { id: "system", label: "System", hint: "Top-level components and external dependencies" },
  { id: "file", label: "Files", hint: "Every file and its imports" },
  { id: "symbol", label: "Symbols", hint: "Classes, functions, endpoints, tables" },
];
const SYMBOL_KINDS: NodeKind[] = ["class", "function", "method", "endpoint", "table"];

export function GraphExplorer() {
  const { repo } = useRepo();
  const router = useRouter();
  const sp = useSearchParams();
  const level = (sp.get("level") as GraphLevel) || "file";
  const focus = sp.get("focus");
  const depth = Number(sp.get("depth") || 1);
  const prefix = sp.get("prefix") ?? "";
  const [selected, setSelected] = useState<string | null>(sp.get("node"));
  const [kinds, setKinds] = useState<Set<NodeKind>>(new Set(SYMBOL_KINDS));
  const [q, setQ] = useState("");
  const dq = useDebounced(q);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      router.replace(`/repos/${repo.id}/map?${next.toString()}`);
    },
    [router, sp, repo.id],
  );

  const kindsParam = level === "symbol" && !focus ? ["file", ...kinds].join(",") : undefined;
  const key = `graph:${repo.id}:${repo.updated_at}:${level}:${focus ?? ""}:${depth}:${prefix}:${kindsParam ?? ""}`;
  const { data: graph, error, loading } = useApi(key, () =>
    api.graph.view(repo.id, { level, focus: focus ?? undefined, depth, kinds: kindsParam, path_prefix: prefix || undefined }),
  );

  const search = useApi(dq.length >= 2 ? `search:${repo.id}:${dq}` : null, () => api.graph.search(repo.id, dq));

  useEffect(() => {
    if (selected) setParams({ node: selected });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const drill = useCallback(
    (id: string) => {
      const n = graph?.nodes.find((x) => x.id === id);
      if (!n) return;
      if (n.kind === "directory") setParams({ prefix: n.path, level: level === "system" ? "file" : level, focus: null });
      else if (n.kind === "file" && level !== "symbol") setParams({ focus: id, depth: "1", node: id });
      else setParams({ focus: id, depth: String(Math.min(depth + 1, 3)), node: id });
      setSelected(id);
    },
    [graph, level, depth, setParams],
  );

  const pick = (n: GraphNode) => {
    setQ("");
    setSelected(n.id);
    setParams({ focus: n.id, depth: "1", node: n.id, prefix: null });
  };

  const focusNode = useMemo(() => graph?.nodes.find((n) => n.id === focus), [graph, focus]);
  const counts = useMemo(() => {
    const c = new Map<NodeKind, number>();
    for (const n of graph?.nodes ?? []) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
    return c;
  }, [graph]);

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 px-3 py-2 border-b border-line bg-elev/60 flex-wrap">
          <div className="flex rounded-md border border-line-strong overflow-hidden">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                title={l.hint}
                className={clsx("px-3 py-1.5 text-xs", level === l.id && !focus ? "bg-accent-soft text-accent" : "text-muted hover:text-fg")}
                onClick={() => setParams({ level: l.id, focus: null, depth: null })}
              >
                {l.label}
              </button>
            ))}
          </div>

          {level === "symbol" && !focus && (
            <div className="flex items-center gap-1">
              {SYMBOL_KINDS.map((k) => (
                <button
                  key={k}
                  className={clsx("chip", !kinds.has(k) && "opacity-40")}
                  style={kinds.has(k) ? { color: KIND_STYLE[k].color, borderColor: `${KIND_STYLE[k].color}55` } : undefined}
                  onClick={() =>
                    setKinds((s) => {
                      const n = new Set(s);
                      if (n.has(k)) n.delete(k);
                      else n.add(k);
                      return n;
                    })
                  }
                >
                  {KIND_STYLE[k].label}
                </button>
              ))}
            </div>
          )}

          {(prefix || focus) && (
            <div className="flex items-center gap-1 text-xs">
              <button className="btn btn-ghost px-2" title="Reset view" onClick={() => setParams({ prefix: null, focus: null, depth: null })}><Home size={14} /></button>
              {prefix && <span className="chip mono">{prefix}/</span>}
              {focus && (
                <>
                  <span className="chip mono">focus: {focusNode?.name ?? focus.slice(0, 8)}</span>
                  <span className="text-faint">depth</span>
                  {[1, 2, 3].map((d) => (
                    <button key={d} className={clsx("chip", depth === d && "text-accent border-accent/50")} onClick={() => setParams({ depth: String(d) })}>{d}</button>
                  ))}
                </>
              )}
            </div>
          )}

          <div className="relative ml-auto w-72">
            <Search size={14} className="absolute left-2.5 top-2.5 text-faint" />
            <input className="input pl-8 py-1.5" placeholder="Search symbols, files, endpoints…" value={q} onChange={(e) => setQ(e.target.value)} />
            {dq.length >= 2 && (
              <div className="absolute z-20 mt-1 w-[420px] right-0 card shadow-xl max-h-80 overflow-y-auto">
                {search.loading && !search.data && <div className="p-3 text-muted text-xs flex items-center gap-2"><Spinner /> Searching…</div>}
                {search.data?.results.length === 0 && <div className="p-3 text-faint text-xs">No matches.</div>}
                {search.data?.results.map((n) => (
                  <button key={n.id} className="w-full text-left px-3 py-1.5 hover:bg-elev2 flex items-center gap-2 text-xs" onClick={() => pick(n)}>
                    <KindBadge kind={n.kind} className="shrink-0" />
                    <span className="mono truncate">{n.kind === "method" && n.meta.class ? `${n.meta.class}.` : ""}{n.name}</span>
                    <span className="text-faint truncate ml-auto">{n.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="relative flex-1 min-h-0 bg-bg">
          {error && <div className="absolute top-3 left-3 z-10"><ErrorBox>{error}</ErrorBox></div>}
          {loading && <div className="absolute top-3 left-3 z-10 chip"><Spinner className="h-3 w-3" /> loading graph</div>}
          {graph && <GraphCanvas graph={graph} selected={selected} onSelect={setSelected} onDrill={drill} />}
          {graph && graph.nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-faint">Nothing to show at this level.</div>}

          <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 pointer-events-none">
            <div className="card px-3 py-2 text-[11px] text-muted space-y-1">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {[...counts.entries()].map(([k, c]) => (
                  <span key={k} className="flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ background: KIND_STYLE[k].color }} />{KIND_STYLE[k].label} {c}</span>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 border-t border-line">
                {Object.entries(EDGE_STYLE).filter(([k]) => graph?.edges.some((e) => e.kind === k)).map(([k, s]) => (
                  <span key={k} className="flex items-center gap-1"><span className="inline-block w-4 border-t-2" style={{ borderColor: s.color, borderStyle: s.style }} />{s.label}</span>
                ))}
              </div>
              <div className="text-faint pt-1 border-t border-line">click: inspect · double-click: drill in · scroll: zoom</div>
            </div>
          </div>
        </div>
      </div>

      {selected && (
        <NodePanel
          repoId={repo.id}
          nodeId={selected}
          onClose={() => { setSelected(null); setParams({ node: null }); }}
          onSelect={(id) => setSelected(id)}
          onFocus={(id) => setParams({ focus: id, depth: "1", node: id, prefix: null })}
        />
      )}
    </div>
  );
}
