"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp, HeartPulse, Layers, Maximize2, Search } from "lucide-react";
import { api, EDGE_STYLE, KIND_STYLE } from "@/lib/api";
import type { Graph, GraphNode } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { MapCanvas, type Crumb, type MapController, type MapKey, type NodeAction } from "@/components/graph/MapCanvas";
import { MapControls } from "@/components/graph/MapControls";
import { HEALTH_LABELS, HEALTH_TILES, MAP_BG } from "@/components/graph/palette";
import { runAction } from "@/components/graph/nodeActions";
import { NodePanel } from "@/components/graph/NodePanel";
import { ErrorBox, KindBadge, Spinner } from "@/components/ui";

const KEY_OPEN = "archon.map.key.open";
const PANEL_W = 380; // details panel width (it slides over the map)

// The whole-hierarchy graph, kept while you visit other tabs of the same repository (the camera is
// remembered by the map itself), so coming back to the Code Map is instant and keeps your place.
const graphCache = new Map<string, Graph>();

/**
 * Semantic-zoom code map (decisions.md D-024, D-026, D-027, D-029). One request loads the whole hierarchy; the canvas
 * decides how much detail to draw for the current zoom. Deep links from other pages (`?node=`, `?focus=`,
 * `?prefix=`) fly the camera to that part of the map.
 */
export function GraphExplorer() {
  const { repo } = useRepo();
  const router = useRouter();
  const sp = useSearchParams();
  const [lens, setLens] = useState<"structure" | "health">("structure");
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
  const [mapCtrl, setMapCtrl] = useState<MapController | null>(null);
  const [keyH, setKeyH] = useState(0);
  const [active, setActive] = useState(0); // highlighted search result
  const searchRef = useRef<HTMLInputElement>(null);
  // the details panel slides over the map; the last node stays in it while it slides out (derived during
  // render, the React way to keep state in step with a prop)
  const [panelId, setPanelId] = useState<string | null>(selected);
  if (selected && selected !== panelId) setPanelId(selected);
  const panelOpen = !!selected;

  const graphKey = `graph:${repo.id}:${repo.updated_at}:all`;
  const { data: graph, error, loading } = useApi(graphKey, async () => {
    const hit = graphCache.get(graphKey);
    if (hit) return hit;
    const g = await api.graph.view(repo.id, { level: "all" });
    if (graphCache.size >= 3) graphCache.delete(graphCache.keys().next().value as string);
    graphCache.set(graphKey, g);
    return g;
  });
  // findings are only loaded for the Health lens (and kept while it is on)
  const findings = useApi(lens === "health" ? `map-findings:${repo.id}:${repo.updated_at}` : null, () =>
    api.analysis.findings(repo.id, { status: "open", limit: 2000 }),
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
    setMapCtrl(c);
  }, []);

  // "/" jumps to search; Esc closes the details panel (keys are left alone while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && selected) setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  useEffect(() => {
    if (!graph || !prefix) return;
    const t = setTimeout(() => ctrl.current?.zoomToPath(prefix), 600);
    return () => clearTimeout(t);
  }, [graph, prefix]);

  const pick = (n: GraphNode) => {
    setQ("");
    setActive(0);
    setSelected(n.id);
    ctrl.current?.zoomTo(n.id, { pulse: 2 }); // two pings where it landed, so the eye finds it
  };
  const results = search.data?.results ?? [];
  // the highlighted search result gets a soft ring on the map (the camera stays put until you pick it)
  const previewId = dq.length >= 2 ? (results[active]?.id ?? null) : null;
  useEffect(() => {
    mapCtrl?.preview(previewId);
  }, [mapCtrl, previewId]);
  const onAction = useCallback(
    (kind: NodeAction, id: string) => {
      const n = graph?.nodes.find((x) => x.id === id);
      if (n) runAction(kind, repo, n, (href) => router.push(href));
    },
    [graph, repo, router],
  );
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      pick(results[active]);
    } else if (e.key === "Escape") {
      setQ("");
      e.currentTarget.blur();
    }
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

          {/* lens: the calm structure view, or a soft heat map of open findings per 1,000 lines */}
          <div className="ml-auto flex items-center rounded-md border border-line-strong overflow-hidden text-xs shrink-0">
            <button
              className={`px-2.5 py-1.5 flex items-center gap-1.5 ${lens === "structure" ? "bg-elev2 text-fg" : "text-muted hover:text-fg"}`}
              onClick={() => setLens("structure")}
              title="Colour by area"
            >
              <Layers size={13} /> Structure
            </button>
            <button
              className={`px-2.5 py-1.5 flex items-center gap-1.5 border-l border-line-strong ${lens === "health" ? "bg-elev2 text-fg" : "text-muted hover:text-fg"}`}
              onClick={() => setLens("health")}
              title="Colour by open findings per 1,000 lines (from the Audit tab's analysis)"
            >
              <HeartPulse size={13} /> Health
            </button>
          </div>

          <div className="relative w-72 shrink-0">
            <Search size={14} className="absolute left-2.5 top-2.5 text-faint" />
            <input
              ref={searchRef}
              className="input pl-8 py-1.5"
              placeholder="Find a file, function, endpoint…  ( / )"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
            />
            {dq.length >= 2 && (
              <div className="absolute z-20 mt-1 w-[420px] right-0 card shadow-xl max-h-80 overflow-y-auto">
                {search.loading && !search.data && (
                  <div className="p-3 text-muted text-xs flex items-center gap-2"><Spinner /> Searching…</div>
                )}
                {search.data?.results.length === 0 && <div className="p-3 text-faint text-xs">No matches.</div>}
                {results.map((n, i) => (
                  <button
                    key={n.id}
                    className={`w-full text-left px-3 py-1.5 hover:bg-elev2 flex items-center gap-2 text-xs ${i === active ? "bg-elev2" : ""}`}
                    onMouseEnter={() => setActive(i)}
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
              insetRight={panelOpen ? PANEL_W : 0}
              lens={lens}
              findings={findings.data?.findings ?? null}
              onAction={onAction}
              storageKey={`archon.map.camera.${repo.id}`}
            />
          )}

          {mapKey && (
            <MapLegend
              mapKey={mapKey}
              open={keyOpen}
              onToggle={toggleKey}
              onHeight={setKeyH}
              health={lens === "health" ? { loading: findings.loading && !findings.data, count: findings.data?.findings.length ?? 0 } : null}
            />
          )}
          {graph && <MapControls ctrl={mapCtrl} right={panelOpen ? PANEL_W : 0} />}

          {/* the details panel slides over the map: the map keeps its size, so nothing opens or jumps */}
          {panelId && (
            <div
              aria-hidden={!panelOpen}
              className={`absolute inset-y-0 right-0 z-20 transition-transform ease-out ${panelOpen ? "shadow-[-12px_0_24px_rgba(0,0,0,0.35)]" : "pointer-events-none"}`}
              style={{
                width: PANEL_W,
                transform: panelOpen ? "translateX(0)" : `translateX(${PANEL_W + 24}px)`,
                transitionDuration: panelOpen ? "220ms" : "180ms",
              }}
            >
              <NodePanel
                repoId={repo.id}
                nodeId={panelId}
                onClose={() => setSelected(null)}
                onSelect={(id) => {
                  setSelected(id);
                  ctrl.current?.zoomTo(id, { pulse: 1 });
                }}
                onFocus={(id) => ctrl.current?.zoomTo(id, { pulse: 1 })}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A key that explains exactly what this map draws: its areas, symbol kinds and line styles. */
function MapLegend({
  mapKey,
  open,
  onToggle,
  onHeight,
  health,
}: {
  mapKey: MapKey;
  open: boolean;
  onToggle: () => void;
  onHeight: (h: number) => void;
  health: { loading: boolean; count: number } | null;
}) {
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
  }, [onHeight, open, health]);
  return (
    <div ref={ref} className="absolute bottom-3 left-3 z-10 max-w-[min(560px,calc(100%-24px))]">
      <div className="rounded-lg border border-line px-3 py-2 text-[11px] text-muted shadow-lg" style={{ background: `${MAP_BG}eb` }}>
        <button className="flex items-center gap-1.5 text-faint hover:text-fg w-full" onClick={onToggle} title={open ? "Hide the key" : "Show the key"}>
          {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          <span>Key</span>
          {!open && <span className="text-faint">· scroll to zoom · drag to pan · double-click to go in or out · / to search</span>}
        </button>
        {open && (
          <div className="mt-1.5 space-y-1.5">
            {health && (
              <Row title="Health">
                {health.loading ? (
                  <span className="text-faint">loading findings…</span>
                ) : health.count === 0 ? (
                  <span className="text-faint">no open findings: run an analysis on the Audit tab</span>
                ) : (
                  <>
                    {HEALTH_TILES.map((t, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        <span className="h-2.5 w-3.5 rounded-[3px]" style={{ background: `linear-gradient(${t.top}, ${t.bottom})`, border: `1px solid ${t.border}` }} />
                        {HEALTH_LABELS[i]}
                      </span>
                    ))}
                    <span className="text-faint">· findings per 1,000 lines · {health.count} open</span>
                  </>
                )}
              </Row>
            )}
            {!health && mapKey.areas.length > 0 && (
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
            <div className="text-faint">
              Scroll to zoom · drag to pan · click to inspect (its lines light up: amber = uses, periwinkle = used by) · right-click for
              next steps · double-click to go in, on empty space or a title to step out · hover a line to see what it carries · keys:
              Backspace up · 0 fit all · + − zoom · arrows pan · / search · Esc clear
            </div>
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
