"use client";

/**
 * Semantic-zoom code map (decisions.md D-024).
 *
 * The whole hierarchy (folders → files → classes → functions, plus packages) is laid out once. What is
 * drawn depends on zoom: a box is shown as a solid tile with a summary until it is large enough on screen
 * to be worth opening; then it becomes a frame and its children appear. Relationships are drawn between
 * whatever is currently visible (lifted from the code-level edges and counted), so zoomed out you see a
 * handful of thick lines between parts of the system, and zoomed in you see individual calls.
 * Positions never change while zooming — detail is revealed in place, like a street map.
 */
import { useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition, NodeSingular } from "cytoscape";
import { EDGE_STYLE, KIND_STYLE, type Graph, type NodeKind } from "@/lib/api";
import { cachedLayout, computeLayout, viewKey, type Positions } from "./layoutClient";
import { buildView, isSynthetic, type ViewModel } from "./viewModel";

export interface Crumb {
  id: string;
  label: string;
}

export interface MapController {
  zoomTo: (id: string) => void;
  /** Fly to everything under a folder path (works even when that folder was merged away). */
  zoomToPath: (path: string) => void;
  reset: () => void;
}

interface Props {
  graph: Graph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCrumbs?: (crumbs: Crumb[]) => void;
  onReady?: (ctrl: MapController) => void;
}

// ---- tuning -----------------------------------------------------------------------------------------
/** A box opens once it covers this share of the screen's area… */
const OPEN_AREA = 0.3;
/** …or this share of the screen's width or height (long, thin boxes). */
const OPEN_SPAN = 0.7;
/** Soft hues for top-level components; folders and files inside inherit their component's hue. */
const COMPONENT_HUES = ["#8fb8de", "#a8d5ba", "#c3b1e1", "#f0c7a2", "#e6a9b8", "#9fd3cf", "#b6c2e8", "#e3d6a0"];
const BG = "#12151c";
const TEXT = "#dfe3ea";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const SANS = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";

/** Mix a hue into the background: solid, soft tints (lines can then pass neatly behind tiles). */
function tint(hex: string, amount: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(hex), p(BG)];
  return `#${a.map((v, i) => Math.round(b[i] + (v - b[i]) * amount).toString(16).padStart(2, "0")).join("")}`;
}

interface MapNode {
  id: string;
  parent?: string;
  kind: string;
  label: string;
  path: string;
  box: boolean;
  depth: number;
  children: string[];
  ancestors: string[]; // nearest first
  rect: { x: number; y: number; w: number; h: number; header?: number };
}

interface Model {
  nodes: Map<string, MapNode>;
  roots: string[];
  edges: { source: string; target: string; kind: string }[];
}

function summarize(id: string, nodes: Map<string, MapNode>): string {
  const counts: Record<string, number> = {};
  const walk = (n: MapNode) => {
    for (const c of n.children) {
      const m = nodes.get(c)!;
      counts[m.kind] = (counts[m.kind] ?? 0) + 1;
      walk(m);
    }
  };
  walk(nodes.get(id)!);
  const parts: [string, number][] = [
    ["folder", counts.directory ?? 0],
    ["file", counts.file ?? 0],
    ["class", counts.class ?? 0],
    ["function", (counts.function ?? 0) + (counts.method ?? 0)],
    ["endpoint", counts.endpoint ?? 0],
    ["table", counts.table ?? 0],
    ["package", counts.dependency ?? 0],
  ];
  return parts
    .filter(([, n]) => n > 0)
    .slice(0, 2)
    .map(([w, n]) => `${n} ${w}${n === 1 ? "" : w === "class" ? "es" : "s"}`)
    .join(" · ");
}

function buildModel(view: ViewModel, pos: Positions): Model {
  const nodes = new Map<string, MapNode>();
  const kids = new Map<string, string[]>();
  for (const v of view.nodes) {
    if (v.parent) {
      if (!kids.has(v.parent)) kids.set(v.parent, []);
      kids.get(v.parent)!.push(v.id);
    }
  }
  for (const v of view.nodes) {
    const r = pos[v.id];
    if (!r) continue;
    nodes.set(v.id, {
      id: v.id,
      parent: v.parent,
      kind: v.kind,
      label: v.label,
      path: v.path,
      box: kids.has(v.id),
      depth: 0,
      children: kids.get(v.id) ?? [],
      ancestors: [],
      rect: r,
    });
  }
  for (const n of nodes.values()) {
    for (let p = n.parent; p && nodes.has(p); p = nodes.get(p)!.parent) n.ancestors.push(p);
    n.depth = n.ancestors.length;
  }
  return {
    nodes,
    roots: [...nodes.values()].filter((n) => !n.parent || !nodes.has(n.parent)).map((n) => n.id),
    edges: view.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)),
  };
}

function toElements(model: Model): ElementDefinition[] {
  // biggest components get the first hues; everything inside a component shares its hue
  const byArea = [...model.roots].sort((a, b) => {
    const ra = model.nodes.get(a)!.rect, rb = model.nodes.get(b)!.rect;
    return rb.w * rb.h - ra.w * ra.h;
  });
  const hueOf = new Map(byArea.map((id, i) => [id, COMPONENT_HUES[i % COMPONENT_HUES.length]]));
  return [...model.nodes.values()].map((n) => {
    const { x, y, w, h, header = 20 } = n.rect;
    const tileChars = Math.max(n.label.length, 10);
    // tile text is sized to the tile, so a zoomed-out overview stays readable
    const tileFont = Math.max(10, Math.min((w * 0.82) / (tileChars * 0.6), h / 3.4, 160));
    const root = n.ancestors.length ? n.ancestors[n.ancestors.length - 1] : n.id;
    const kindColor = KIND_STYLE[n.kind as NodeKind]?.color ?? "#9aabc4";
    const color =
      n.kind === "group" || model.nodes.get(root)?.kind === "group"
        ? KIND_STYLE.dependency.color
        : n.box
          ? (hueOf.get(root) ?? kindColor)
          : kindColor;
    return {
      group: "nodes",
      data: {
        id: n.id,
        kind: n.kind,
        color,
        tileFill: tint(color, 0.26),
        frameFill: tint(color, Math.min(0.05 + n.depth * 0.025, 0.14)),
        label: n.label,
        tileLabel: n.box ? `${n.label}\n${summarize(n.id, model.nodes)}` : n.label,
        w: n.box ? w : Math.max(10, h - 18), // leaves: drawn node size (footprint minus label slot)
        h: n.box ? h : Math.max(10, h - 18),
        tileFont,
        fontNow: tileFont,
        frameFont: header * 0.55,
        frameMarginY: -h / 2 + header * 0.55,
        z: n.box ? n.depth : 1000,
      },
      position: { x, y },
      classes: n.box ? "box" : "leaf",
    };
  });
}

/** Move the camera: animated when the page is visible; a hidden tab gets the destination at once
 *  (animations advance on animation frames, which browsers pause for hidden pages). */
function fly(cy: Core, to: { zoom: number; pan: { x: number; y: number } }): void {
  cy.stop();
  if (document.visibilityState === "visible") cy.animate(to, { duration: 450, easing: "ease-in-out-cubic" });
  else cy.viewport(to);
}

type LayoutState = { state: "idle" } | { state: "running"; nodes: number } | { state: "error"; message: string };

export function GraphCanvas({ graph, selected, onSelect, onCrumbs, onReady }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const modelRef = useRef<Model | null>(null);
  const shown = useRef<{ visible: Set<string>; open: Set<string>; edgeSig: string }>({
    visible: new Set(),
    open: new Set(),
    edgeSig: "",
  });
  const graphRef = useRef(graph);
  const renderSeq = useRef(0);
  const cleanup = useRef<(() => void) | null>(null);
  const [layout, setLayout] = useState<LayoutState>({ state: "idle" });
  const cb = useRef({ onSelect, onCrumbs, onReady, selected });
  useEffect(() => {
    cb.current = { onSelect, onCrumbs, onReady, selected };
    graphRef.current = graph;
  });

  // ---- selection: highlight the selected thing (or the tile that currently stands in for it) --------
  const applySelection = () => {
    const cy = cyRef.current;
    const model = modelRef.current;
    if (!cy || !model) return;
    const sel = cb.current.selected;
    cy.batch(() => {
      cy.elements().removeClass("dim hl");
      cy.$(":selected").unselect();
      if (!sel || !model.nodes.has(sel)) return;
      const n = model.nodes.get(sel)!;
      const standIn =
        [sel, ...n.ancestors].find((id) => shown.current.visible.has(id) && !shown.current.open.has(id)) ?? sel;
      const el = cy.getElementById(standIn);
      if (el.empty()) return;
      el.select();
      const lit = el.closedNeighborhood();
      cy.elements().not(lit).not(".frame").addClass("dim");
      lit.addClass("hl");
    });
  };

  // ---- level of detail ---------------------------------------------------------------------------
  const refreshDetail = () => {
    const cy = cyRef.current;
    const model = modelRef.current;
    if (!cy || !model) return;
    const z = cy.zoom();
    const vw = cy.width();
    const vh = cy.height();
    const ext = cy.extent();
    const margin = Math.max(ext.w, ext.h) * 0.25;
    const onScreen = (r: MapNode["rect"]) =>
      r.x + r.w / 2 > ext.x1 - margin &&
      r.x - r.w / 2 < ext.x2 + margin &&
      r.y + r.h / 2 > ext.y1 - margin &&
      r.y - r.h / 2 < ext.y2 + margin;
    const opens = (n: MapNode) =>
      n.box &&
      onScreen(n.rect) &&
      (n.rect.w * z * n.rect.h * z >= vw * vh * OPEN_AREA || n.rect.w * z >= vw * OPEN_SPAN || n.rect.h * z >= vh * OPEN_SPAN);

    const visible = new Set<string>();
    const open = new Set<string>();
    const walk = (id: string, forceOpen: boolean) => {
      const n = model.nodes.get(id)!;
      visible.add(id);
      if (n.box && (forceOpen || opens(n))) {
        open.add(id);
        for (const c of n.children) walk(c, false);
      }
    };
    // a single top-level box is always opened: an overview of one tile says nothing
    for (const r of model.roots) walk(r, model.roots.length === 1);

    // Relationships between what is visible: each code-level edge is drawn between the nearest visible
    // stand-ins of its two ends, and parallel ones are merged into one line with a count.
    const rep = (id: string): string | undefined => {
      const n = model.nodes.get(id)!;
      for (const c of [id, ...n.ancestors]) if (visible.has(c) && !open.has(c)) return c;
      return undefined;
    };
    const inView = (r: MapNode["rect"]) =>
      r.x + r.w / 2 > ext.x1 && r.x - r.w / 2 < ext.x2 && r.y + r.h / 2 > ext.y1 && r.y - r.h / 2 < ext.y2;
    const merged = new Map<string, { s: string; t: string; count: number; kinds: Map<string, number> }>();
    for (const e of model.edges) {
      const s = rep(e.source);
      const t = rep(e.target);
      if (!s || !t || s === t) continue;
      // a line to something off-screen is just a stroke across the view: leave it out
      if (!inView(model.nodes.get(s)!.rect) || !inView(model.nodes.get(t)!.rect)) continue;
      const key = `${s}>${t}`;
      const m = merged.get(key) ?? { s, t, count: 0, kinds: new Map() };
      m.count++;
      m.kinds.set(e.kind, (m.kinds.get(e.kind) ?? 0) + 1);
      merged.set(key, m);
    }
    const edgeSig = [...merged.keys()].sort().join("|");

    const prev = shown.current;
    cy.batch(() => {
      for (const [id, n] of model.nodes) {
        const el = cy.getElementById(id);
        const isVis = visible.has(id);
        const wasVis = prev.visible.has(id);
        if (isVis !== wasVis) {
          el.style("display", isVis ? "element" : "none");
          if (isVis) el.addClass("fresh");
        }
        const isOpen = open.has(id);
        if (n.box && (isOpen !== prev.open.has(id) || isVis !== wasVis)) {
          el.toggleClass("frame", isOpen);
          el.toggleClass("tile", !isOpen);
        }
      }
      if (edgeSig !== prev.edgeSig) {
        cy.edges().remove();
        cy.add(
          [...merged.entries()].map(([key, m]) => {
            const kind = [...m.kinds.entries()].sort((a, b) => b[1] - a[1])[0][0];
            const local = model.nodes.get(m.s)!.parent === model.nodes.get(m.t)!.parent;
            return {
              group: "edges" as const,
              data: { id: `m:${key}`, source: m.s, target: m.t, kind, count: m.count },
              classes: local ? "local" : "cross",
            };
          }),
        );
      }
    });
    // Tiles too small on screen to hold their own name show it underneath at a readable size instead.
    cy.batch(() => {
      for (const id of visible) {
        const n = model.nodes.get(id)!;
        if (!n.box || open.has(id)) continue;
        const el = cy.getElementById(id);
        // tile text stays between 10 and 20 px on screen; below that the name moves under the tile
        const px = Number(el.data("tileFont")) * z;
        const small = px < 10;
        el.toggleClass("small", small);
        if (small) el.data("smallFont", 12 / z);
        else el.data("fontNow", Math.min(px, 20) / z);
      }
    });
    // Lines and borders keep the same on-screen thickness at every zoom (Cytoscape scales them otherwise).
    cy.batch(() => {
      cy.edges().forEach((e) => {
        const px = 1.2 + 4 * Math.min(1, Math.log2(Number(e.data("count")) + 1) / Math.log2(41));
        e.data("px", px / z);
      });
    });
    cy.style()
      .selector("node.tile")
      .style({ "border-width": 1.5 / z })
      .selector("node.frame")
      .style({ "border-width": 1.2 / z })
      .selector("node:selected")
      .style({ "border-width": 3 / z })
      .update();
    shown.current = { visible, open, edgeSig };
    setTimeout(() => cy.nodes(".fresh").removeClass("fresh"), 16); // fade newly revealed things in
    applySelection();

    // breadcrumb: the deepest open box under the centre of the screen
    const cx = (ext.x1 + ext.x2) / 2;
    const cyy = (ext.y1 + ext.y2) / 2;
    let deepest: MapNode | undefined;
    for (const id of open) {
      const n = model.nodes.get(id)!;
      const r = n.rect;
      if (Math.abs(cx - r.x) <= r.w / 2 && Math.abs(cyy - r.y) <= r.h / 2 && (!deepest || n.depth > deepest.depth)) {
        deepest = n;
      }
    }
    const crumbs: Crumb[] = deepest
      ? [...deepest.ancestors]
          .reverse()
          .concat(deepest.id)
          .map((id) => ({ id, label: model.nodes.get(id)!.label }))
      : [];
    cb.current.onCrumbs?.(crumbs.filter((c) => !(model.roots.length === 1 && c.id === model.roots[0])));
  };

  // ---- camera ------------------------------------------------------------------------------------
  const zoomTo = (id: string) => {
    const cy = cyRef.current;
    const model = modelRef.current;
    const n = model?.nodes.get(id);
    if (!cy || !model || !n) return;
    // to see a leaf we must open its box; to see a box's contents we fit the box itself
    const target = n.box ? n : (model.nodes.get(n.parent ?? "") ?? n);
    const { x, y, w, h } = target.rect;
    const pad = 0.08;
    const zoom = Math.min(cy.width() / (w * (1 + 2 * pad)), cy.height() / (h * (1 + 2 * pad)), cy.maxZoom());
    fly(cy, { zoom, pan: { x: cy.width() / 2 - x * zoom, y: cy.height() / 2 - y * zoom } });
  };
  const zoomToPath = (path: string) => {
    const cy = cyRef.current;
    const model = modelRef.current;
    if (!cy || !model) return;
    const under = [...model.nodes.values()].filter((n) => n.path === path || n.path.startsWith(`${path}/`));
    const ids = new Set(under.map((n) => n.id));
    const tops = under.filter((n) => !n.parent || !ids.has(n.parent));
    if (!tops.length) return;
    if (tops.length === 1) return zoomTo(tops[0].id);
    const x1 = Math.min(...tops.map((n) => n.rect.x - n.rect.w / 2));
    const x2 = Math.max(...tops.map((n) => n.rect.x + n.rect.w / 2));
    const y1 = Math.min(...tops.map((n) => n.rect.y - n.rect.h / 2));
    const y2 = Math.max(...tops.map((n) => n.rect.y + n.rect.h / 2));
    const zoom = Math.min((cy.width() * 0.9) / (x2 - x1), (cy.height() * 0.9) / (y2 - y1), cy.maxZoom());
    fly(cy, { zoom, pan: { x: cy.width() / 2 - ((x1 + x2) / 2) * zoom, y: cy.height() / 2 - ((y1 + y2) / 2) * zoom } });
  };
  const reset = () => {
    const cy = cyRef.current;
    const model = modelRef.current;
    if (!cy || !model) return;
    const tops = model.roots.map((r) => model.nodes.get(r)!.rect);
    const x1 = Math.min(...tops.map((r) => r.x - r.w / 2));
    const x2 = Math.max(...tops.map((r) => r.x + r.w / 2));
    const y1 = Math.min(...tops.map((r) => r.y - r.h / 2));
    const y2 = Math.max(...tops.map((r) => r.y + r.h / 2));
    const zoom = Math.min((cy.width() - 80) / (x2 - x1), (cy.height() - 80) / (y2 - y1));
    return { zoom, pan: { x: cy.width() / 2 - ((x1 + x2) / 2) * zoom, y: cy.height() / 2 - ((y1 + y2) / 2) * zoom } };
  };

  // Latest closures for the long-lived Cytoscape event handlers.
  const fns = useRef({ refreshDetail, applySelection, zoomTo, zoomToPath, reset });
  useEffect(() => {
    fns.current = { refreshDetail, applySelection, zoomTo, zoomToPath, reset };
  });

  // ---- build / rebuild -------------------------------------------------------------------------------
  const render = (cy: Core, g: Graph) => {
    const seq = ++renderSeq.current;
    const view = buildView(g);
    const key = viewKey(view);
    const apply = (pos: Positions) => {
      if (seq !== renderSeq.current || cyRef.current !== cy) return;
      const model = buildModel(view, pos);
      modelRef.current = model;
      shown.current = { visible: new Set(), open: new Set(), edgeSig: "" };
      cy.batch(() => {
        cy.elements().remove();
        cy.add(toElements(model));
        cy.nodes().style("display", "none");
      });
      const home = fns.current.reset();
      if (home) {
        cy.minZoom(home.zoom * 0.5);
        cy.viewport(home);
      }
      fns.current.refreshDetail();
      setLayout({ state: "idle" });
      const sel = cb.current.selected;
      if (sel && model.nodes.has(sel)) setTimeout(() => fns.current.zoomTo(sel), 50);
    };
    const cached = cachedLayout(key);
    if (cached) return apply(cached);
    setLayout({ state: "running", nodes: view.nodes.length });
    computeLayout(view, key).then(apply, (err: Error) => {
      if (seq !== renderSeq.current || err.message === "superseded") return;
      setLayout({ state: "error", message: err.message });
    });
  };
  const renderRef = useRef(render);
  useEffect(() => {
    renderRef.current = render;
  });

  useEffect(() => {
    let disposed = false;
    (async () => {
      const { default: cytoscape } = await import("cytoscape");
      if (disposed || !ref.current) return;
      const cy = cytoscape({
        container: ref.current,
        motionBlur: false,
        autoungrabify: true, // structure, not a toy: nodes stay where the layout put them
        boxSelectionEnabled: false,
        maxZoom: 4,
        style: [
          // ---- boxes
          {
            selector: "node.box",
            style: {
              shape: "round-rectangle",
              width: "data(w)",
              height: "data(h)",
              "z-index-compare": "manual",
              "z-index": "data(z)",
              "background-color": "data(color)",
              "border-color": "data(color)",
              "font-family": SANS,
              color: TEXT,
              "text-wrap": "wrap",
              "transition-property": "opacity",
              "transition-duration": 220,
            },
          },
          // a closed box: a soft tile with its name and what is inside
          {
            selector: "node.tile",
            style: {
              "background-color": "data(tileFill)",
              "background-opacity": 1,
              "border-width": 1.5,
              "border-opacity": 0.75,
              label: "data(tileLabel)",
              "font-size": "data(fontNow)",
              "font-weight": 600,
              "text-valign": "center",
              "text-halign": "center",
              "text-max-width": "data(w)",
              "line-height": 1.35,
              "z-index": 950,
              "min-zoomed-font-size": 7,
            },
          },
          // an open box: a faint frame with its name in the title band
          {
            selector: "node.frame",
            style: {
              "background-color": "data(frameFill)",
              "background-opacity": 1,
              "border-width": 1,
              "border-opacity": 0.4,
              label: "data(label)",
              "font-size": "data(frameFont)",
              "font-weight": 600,
              color: "data(color)",
              "text-valign": "center",
              "text-halign": "center",
              "text-margin-y": "data(frameMarginY)",
              "text-max-width": "data(w)",
              events: "no", // clicks fall through to what is inside
              "min-zoomed-font-size": 6,
            },
          },
          { selector: 'node.box[kind = "group"]', style: { "border-style": "dashed" } },
          {
            selector: "node.tile.small",
            style: {
              label: "data(label)",
              "font-size": "data(smallFont)",
              "text-valign": "bottom",
              "text-margin-y": 4,
              "text-max-width": "400px",
              "text-wrap": "none",
              "text-background-color": BG,
              "text-background-opacity": 0.85,
              "text-background-padding": "2px",
              "text-background-shape": "roundrectangle",
            },
          },
          // ---- leaves (functions, classes without members, packages…)
          {
            selector: "node.leaf",
            style: {
              width: "data(w)",
              height: "data(h)",
              "z-index-compare": "manual",
              "z-index": 1000,
              "background-color": "data(color)",
              "background-opacity": 0.9,
              "border-width": 0,
              "border-color": "#f2f4f8",
              label: "data(label)",
              color: TEXT,
              "font-family": MONO,
              "font-size": 10,
              "text-valign": "bottom",
              "text-margin-y": 4,
              "text-max-width": "150px",
              "text-wrap": "ellipsis",
              "min-zoomed-font-size": 6,
              "transition-property": "opacity",
              "transition-duration": 220,
            },
          },
          ...(Object.keys(KIND_STYLE) as NodeKind[]).map((k) => ({
            selector: `node.leaf[kind = "${k}"]`,
            style: { shape: KIND_STYLE[k].shape },
          })),
          // ---- relationships: soft curves, thicker when they stand for many code-level links
          {
            selector: "edge",
            style: {
              "curve-style": "unbundled-bezier",
              "control-point-distances": [18],
              "control-point-weights": [0.5],
              width: "data(px)",
              "line-color": "#8a96aa",
              "target-arrow-shape": "triangle",
              "target-arrow-color": "#8a96aa",
              "arrow-scale": 0.7,
              opacity: 0.22,
              "z-index-compare": "manual",
              "z-index": 900,
              "line-cap": "round",
            },
          },
          ...Object.entries(EDGE_STYLE).map(([k, s]) => ({
            selector: `edge[kind = "${k}"]`,
            style: { "line-color": s.color, "target-arrow-color": s.color },
          })),
          // ---- states
          { selector: "edge.local", style: { opacity: 0.5 } },
          { selector: ".fresh", style: { opacity: 0 } },
          { selector: "node:selected", style: { "border-width": 2.5, "border-color": "#f2f4f8", "border-opacity": 1 } },
          { selector: ".dim", style: { opacity: 0.18 } },
          { selector: "edge.hl, edge.hover", style: { opacity: 0.9 } },
          { selector: "node.hover", style: { "border-width": 2, "border-opacity": 0.9 } },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

      cy.on("tap", "node", (ev) => {
        const id: string = ev.target.id();
        if (!isSynthetic(id)) cb.current.onSelect(id);
      });
      cy.on("tap", (ev) => {
        if (ev.target === cy) cb.current.onSelect(null);
      });
      cy.on("dbltap", "node", (ev) => fns.current.zoomTo(ev.target.id())); // open that part of the map
      cy.on("mouseover", "node", (ev) => {
        const n = ev.target as NodeSingular;
        n.addClass("hover");
        n.connectedEdges().addClass("hover");
      });
      cy.on("mouseout", "node", (ev) => {
        (ev.target as NodeSingular).removeClass("hover");
        cy.edges(".hover").removeClass("hover");
      });
      // Re-decide what to show while the user zooms or pans: at most every 70 ms, and always once more
      // after the last movement, so the final frame of an animation is never missed.
      let timer: ReturnType<typeof setTimeout> | null = null;
      let lastEvent = 0;
      let lastRun = 0;
      const tick = () => {
        timer = null;
        lastRun = performance.now();
        fns.current.refreshDetail();
        if (lastEvent > lastRun) timer = setTimeout(tick, 70);
      };
      cy.on("viewport", () => {
        lastEvent = performance.now();
        if (!timer) timer = setTimeout(tick, 70);
      });
      cyRef.current = cy;
      const ro = new ResizeObserver(() => {
        cy.resize();
        fns.current.refreshDetail();
      });
      ro.observe(ref.current);
      cleanup.current = () => ro.disconnect();
      cb.current.onReady?.({
        zoomTo: (id) => fns.current.zoomTo(id),
        zoomToPath: (path) => fns.current.zoomToPath(path),
        reset: () => {
          const home = fns.current.reset();
          if (home) fly(cy, home);
        },
      });
      renderRef.current(cy, graphRef.current);
    })();
    return () => {
      disposed = true;
      cleanup.current?.();
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (cyRef.current) renderRef.current(cyRef.current, graph);
  }, [graph]);

  useEffect(() => {
    fns.current.applySelection();
  }, [selected]);

  return (
    <>
      {/* Inline position: Cytoscape's stylesheet sets `position: relative` on its container, which beats
          Tailwind's layered `absolute` utility and collapses the canvas to 0px height. */}
      <div ref={ref} style={{ position: "absolute", inset: 0, background: BG }} />
      {layout.state === "running" && (
        <div className="absolute top-3 right-3 z-10 chip pointer-events-none">
          <span className="h-1.5 w-1.5 rounded-full bg-accent pulse" /> arranging {layout.nodes} items…
        </div>
      )}
      {layout.state === "error" && (
        <div className="absolute top-3 right-3 z-10 chip text-danger border-danger/40">
          layout failed: {layout.message}
        </div>
      )}
    </>
  );
}
