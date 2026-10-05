"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Maximize2, Search } from "lucide-react";
import { api, KIND_STYLE, type GraphNode, type NodeKind } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { GraphCanvas, type Crumb, type MapController } from "@/components/graph/GraphCanvas";
import { NodePanel } from "@/components/graph/NodePanel";
import { ErrorBox, KindBadge, Spinner } from "@/components/ui";

const LEGEND: NodeKind[] = ["directory", "file", "class", "function", "endpoint", "table", "dependency"];

/**
 * Semantic-zoom code map (decisions.md D-024). One request loads the whole hierarchy; the canvas decides
 * how much detail to draw for the current zoom. Deep links from other pages (`?node=`, `?focus=`,
 * `?prefix=`) fly the camera to that part of the map.
 */
export function GraphExplorer() {
  const { repo } = useRepo();
  const router = useRouter();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<string | null>(sp.get("node") ?? sp.get("focus"));
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const ctrl = useRef<MapController | null>(null);

  const { data: graph, error, loading } = useApi(`graph:${repo.id}:${repo.updated_at}:all`, () =>
    api.graph.view(repo.id, { level: "all" }),
  );
  const search = useApi(dq.length >= 2 ? `search:${repo.id}:${dq}` : null, () => api.graph.search(repo.id, dq));

  // keep `?node=` in sync with the selection so a view can be shared
  useEffect(() => {
    const next = new URLSearchParams(sp.toString());
    if (selected) next.set("node", selected);
    else next.delete("node");
    next.delete("focus");
    next.delete("level");
    next.delete("depth");
    const qs = next.toString();
    router.replace(`/repos/${repo.id}/map${qs ? `?${qs}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // `?prefix=apps/api` (from the Overview's component table) flies to that folder once the map is ready
  const prefix = sp.get("prefix");
  const onReady = useCallback(
    (c: MapController) => {
      ctrl.current = c;
    },
    [],
  );
  useEffect(() => {
    if (!graph || !prefix) return;
    const t = setTimeout(() => ctrl.current?.zoomToPath(prefix), 600);
    return () => clearTimeout(t);
  }, [graph, prefix]);

  const pick = (n: GraphNode) => {
    setQ("");
    setSelected(n.id);
    ctrl.current?.zoomTo(n.id);
  };

  const counts = useMemo(() => {
    const c = new Map<NodeKind, number>();
    for (const n of graph?.nodes ?? []) c.set(n.kind, (c.get(n.kind) ?? 0) + 1);
    return c;
  }, [graph]);

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-elev/60">
          <button className="btn btn-ghost px-2 text-xs" title="Back to the overview" onClick={() => ctrl.current?.reset()}>
            <Maximize2 size={14} /> Overview
          </button>
          {/* where the camera is: the deepest open box under the centre of the screen */}
          <nav className="flex items-center gap-1 text-xs min-w-0 overflow-hidden">
            {crumbs.map((c) => (
              <span key={c.id} className="flex items-center gap-1 min-w-0">
                <ChevronRight size={12} className="text-faint shrink-0" />
                <button className="mono text-muted hover:text-fg truncate" onClick={() => ctrl.current?.zoomTo(c.id)}>
                  {c.label}
                </button>
              </span>
            ))}
          </nav>

          <div className="relative ml-auto w-72 shrink-0">
            <Search size={14} className="absolute left-2.5 top-2.5 text-faint" />
            <input
              className="input pl-8 py-1.5"
              placeholder="Find a file, function, endpoint…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {dq.length >= 2 && (
              <div className="absolute z-20 mt-1 w-[420px] right-0 card shadow-xl max-h-80 overflow-y-auto">
                {search.loading && !search.data && (
                  <div className="p-3 text-muted text-xs flex items-center gap-2"><Spinner /> Searching…</div>
                )}
                {search.data?.results.length === 0 && <div className="p-3 text-faint text-xs">No matches.</div>}
                {search.data?.results.map((n) => (
                  <button
                    key={n.id}
                    className="w-full text-left px-3 py-1.5 hover:bg-elev2 flex items-center gap-2 text-xs"
                    onClick={() => pick(n)}
                  >
                    <KindBadge kind={n.kind} className="shrink-0" />
                    <span className="mono truncate">
                      {n.kind === "method" && n.meta.class ? `${n.meta.class}.` : ""}
                      {n.name}
                    </span>
                    <span className="text-faint truncate ml-auto">{n.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="relative flex-1 min-h-0">
          {error && <div className="absolute top-3 left-3 z-10"><ErrorBox>{error}</ErrorBox></div>}
          {loading && !graph && (
            <div className="absolute top-3 left-3 z-10 chip"><Spinner className="h-3 w-3" /> loading map</div>
          )}
          {graph && (
            <GraphCanvas graph={graph} selected={selected} onSelect={setSelected} onCrumbs={setCrumbs} onReady={onReady} />
          )}

          <div className="absolute bottom-3 left-3 z-10 pointer-events-none">
            <div className="rounded-lg border border-line bg-[#12151c]/90 px-3 py-2 text-[11px] text-muted space-y-1.5 backdrop-blur">
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {LEGEND.filter((k) => counts.has(k)).map((k) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm" style={{ background: KIND_STYLE[k].color }} />
                    {KIND_STYLE[k].label}
                  </span>
                ))}
              </div>
              <div className="text-faint">Scroll to zoom: detail appears as you go in · double-click to open · click to inspect</div>
            </div>
          </div>
        </div>
      </div>

      {selected && (
        <NodePanel
          repoId={repo.id}
          nodeId={selected}
          onClose={() => setSelected(null)}
          onSelect={(id) => {
            setSelected(id);
            ctrl.current?.zoomTo(id);
          }}
          onFocus={(id) => ctrl.current?.zoomTo(id)}
        />
      )}
    </div>
  );
}
