"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, Maximize2, Search } from "lucide-react";
import { api, EDGE_STYLE, KIND_STYLE } from "@/lib/api";
import type { GraphNode } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { MapCanvas, type Crumb, type MapController, type MapKey } from "@/components/graph/MapCanvas";
import { NodePanel } from "@/components/graph/NodePanel";
import { ErrorBox, KindBadge, Spinner } from "@/components/ui";

const MAP_BG = "#0f1218"; // same as the canvas, so nothing flashes before the first frame
const KEY_OPEN = "archon.map.key.open";

/**
 * Semantic-zoom code map (decisions.md D-024, D-026, D-027). One request loads the whole hierarchy; the canvas
 * decides how much detail to draw for the current zoom. Deep links from other pages (`?node=`, `?focus=`,
 * `?prefix=`) fly the camera to that part of the map.
 */
export function GraphExplorer() {
  const { repo } = useRepo();
  const sp = useSearchParams();
  const [selected, setSelected] = useState<string | null>(sp.get("node") ?? sp.get("focus"));
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [mapKey, setMapKey] = useState<MapKey | null>(null);
  // the key is only rendered on the client (after the graph loads), so reading storage here is safe
  const [keyOpen, setKeyOpen] = useState(() => {
    try {
      return window.localStorage.getItem(KEY_OPEN) !== "0";
    } catch {
      return true;
    }
  });
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const ctrl = useRef<MapController | null>(null);
  const [keyH, setKeyH] = useState(0);

  const { data: graph, error, loading } = useApi(`graph:${repo.id}:${repo.updated_at}:all`, () =>
    api.graph.view(repo.id, { level: "all" }),
  );
  const search = useApi(dq.length >= 2 ? `search:${repo.id}:${dq}` : null, () => api.graph.search(repo.id, dq));

  const toggleKey = () => {
    setKeyOpen((o) => {
      try {
        window.localStorage.setItem(KEY_OPEN, o ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !o;
    });
  };

  // keep `?node=` in sync with the selection so a view can be shared. Native history keeps the URL and
  // useSearchParams in sync without a server round-trip on every click.
  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    if (selected) next.set("node", selected);
    else next.delete("node");
    next.delete("focus");
    next.delete("level");
    next.delete("depth");
    const qs = next.toString();
    const url = `/repos/${repo.id}/map${qs ? `?${qs}` : ""}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", url);
  }, [selected, repo.id]);

  // `?prefix=apps/api` (from the Overview's component table) flies to that folder once the map is ready
  const prefix = sp.get("prefix");
  const onReady = useCallback((c: MapController) => {
    ctrl.current = c;
  }, []);
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

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line bg-elev/60">
          <button className="btn btn-ghost px-2 text-xs" title="Show the whole map" onClick={() => ctrl.current?.reset()}>
            <Maximize2 size={14} /> Fit all
          </button>
          {/* where the camera is: the deepest open box under the centre of the screen */}
          <nav className="flex items-center gap-1 text-xs min-w-0 overflow-hidden">
            <button className="mono text-muted hover:text-fg shrink-0" onClick={() => ctrl.current?.reset()}>
              {repo.name}
            </button>
            {crumbs.map((c, i) => (
              <span key={c.id} className="flex items-center gap-1 min-w-0">
                <ChevronRight size={12} className="text-faint shrink-0" />
                <button
                  className={`mono truncate hover:text-fg ${i === crumbs.length - 1 ? "text-fg" : "text-muted"}`}
                  onClick={() => ctrl.current?.zoomTo(c.id)}
                >
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

        <div className="relative flex-1 min-h-0" style={{ background: MAP_BG }}>
          {error && <div className="absolute top-3 left-3 z-10"><ErrorBox>{error}</ErrorBox></div>}
          {loading && !graph && (
            <div className="absolute top-3 left-3 z-10 chip"><Spinner className="h-3 w-3" /> loading map</div>
          )}
          {graph && (
            <MapCanvas
              graph={graph}
              selected={selected}
              onSelect={setSelected}
              onCrumbs={setCrumbs}
              onReady={onReady}
              onKey={setMapKey}
              insetBottom={keyH ? keyH + 16 : 0}
            />
          )}

          {mapKey && <MapLegend mapKey={mapKey} open={keyOpen} onToggle={toggleKey} onHeight={setKeyH} />}
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

/** A key that explains exactly what this map draws: its areas, symbol kinds and line styles. */
function MapLegend({ mapKey, open, onToggle, onHeight }: { mapKey: MapKey; open: boolean; onToggle: () => void; onHeight: (h: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // tell the map how much of its bottom edge the key covers, so fits keep content above it
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onHeight(el.getBoundingClientRect().height);
    report(); // measured directly too: ResizeObserver stays silent in background tabs
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight, open]);
  return (
    <div ref={ref} className="absolute bottom-3 left-3 z-10 max-w-[min(560px,calc(100%-24px))]">
      <div className="rounded-lg border border-line bg-[#0f1218]/92 px-3 py-2 text-[11px] text-muted backdrop-blur shadow-lg">
        <button className="flex items-center gap-1.5 text-faint hover:text-fg w-full" onClick={onToggle} title={open ? "Hide the key" : "Show the key"}>
          {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          <span>Key</span>
          {!open && <span className="text-faint">· scroll to zoom · drag to pan · double-click to fly in or out</span>}
        </button>
        {open && (
          <div className="mt-1.5 space-y-1.5">
            {mapKey.areas.length > 0 && (
              <Row title="Areas">
                {mapKey.areas.map((a) => (
                  <span key={a.id} className="flex items-center gap-1.5">
                    <span className="h-2.5 w-3.5 rounded-[3px]" style={{ background: `linear-gradient(${a.top}, ${a.bottom})`, border: `1px solid ${a.border}` }} />
                    <span className="mono">{a.label}</span>
                  </span>
                ))}
              </Row>
            )}
            {mapKey.symbols.length > 0 && (
              <Row title="Symbols">
                {mapKey.symbols.map((k) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: KIND_STYLE[k]?.color }} />
                    {KIND_STYLE[k]?.label ?? k}
                  </span>
                ))}
              </Row>
            )}
            <Row title="Lines">
              <LineSample label="depends on" color="#a9b3c4" dash={[]} />
              {mapKey.lines
                .filter((k) => EDGE_STYLE[k]?.dash.length)
                .map((k) => (
                  <LineSample key={k} label={EDGE_STYLE[k].label} color={EDGE_STYLE[k].color} dash={EDGE_STYLE[k].dash} />
                ))}
              {mapKey.external && <LineSample label="uses a package" color="#a9b3c4" dash={[1.5, 5]} faint />}
            </Row>
            <div className="text-faint">Scroll to zoom: detail appears as you go in · drag to pan · double-click to fly in, or on empty space to step out · click to inspect</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-faint w-14 shrink-0">{title}</span>
      <div className="flex flex-wrap gap-x-3 gap-y-1">{children}</div>
    </div>
  );
}

function LineSample({ label, color, dash, faint }: { label: string; color: string; dash: number[]; faint?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <svg width="22" height="6" aria-hidden>
        <line x1="1" y1="3" x2="21" y2="3" stroke={color} strokeOpacity={faint ? 0.5 : 0.9} strokeWidth="1.5" strokeLinecap="round" strokeDasharray={dash.join(" ")} />
      </svg>
      {label}
    </span>
  );
}
