"use client";

/**
 * Smooth semantic-zoom code map, rendered on a 2D canvas (decisions.md D-026, D-027, D-029).
 *
 * - Camera: d3-zoom for input (wheel, pinch, drag, keyboard) and fly-to transitions. The drawn view eases
 *   toward d3's target with a time-based glide about the cursor.
 * - Detail: a box's openness follows its on-screen size while you zoom and settles fully open or closed at
 *   rest. Opening is one card: the tile body fades over its frame, the name moves into the header strip.
 * - Relationships: code-level edges spread over the nodes that stand in for their ends. At rest: one calm
 *   ink, the strongest folder links only, routed around unrelated tiles, plugged into their tiles, fading at
 *   the screen edge. The selected item's lines are drawn on top in direction colours (amber = uses,
 *   periwinkle = used by) over a soft veil; hovering lights its lines without the veil.
 * - Labels: one queue drawn after shapes; titles stay in view; sibling tiles share a name size.
 * - Symbols: chips that stay a sane size and turn into small cards (signature, lines, flags) at deep zoom.
 */
import { useEffect, useRef, useState } from "react";
import { pointer, select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { interpolateZoom } from "d3-interpolate";
import "d3-transition";
import "./map.css";
import { EDGE_STYLE, KIND_STYLE, type EdgeKind, type Finding, type Graph, type NodeKind } from "@/lib/api";
import { cachedLayout, computeLayout, viewKey } from "./layoutClient";
import { buildMapModel, withAlpha, type MapModel, type MapNode } from "./mapModel";
import { fitParts, fitSmart, fontOf, measure, type FontSpec } from "./mapText";
import { FOCUS_BOTH, FOCUS_IN, FOCUS_OUT, HEALTH_BINS, HEALTH_TILES, MAP_BG, MAP_INK, MAP_MUTED, MAP_PANEL, mixOklab } from "./palette";
import { buildView, CHIP_H, isSynthetic } from "./viewModel";

export interface Crumb {
  id: string;
  label: string;
}

export interface MapController {
  zoomTo: (id: string, opts?: { pulse?: number }) => void;
  zoomToPath: (path: string) => void;
  reset: () => void;
  upOneLevel: () => void;
  zoomBy: (factor: number) => void;
  fitCurrent: () => void;
  preview: (id: string | null) => void; // a soft ring + one ping on a node, without moving the camera
}

/** Actions offered by the right-click menu (and the details panel). */
export type NodeAction = "impact" | "tests" | "refactor" | "chat" | "copy" | "open";

/** What the legend should explain: only what this map actually draws. */
export interface MapKey {
  areas: { id: string; label: string; top: string; bottom: string; border: string }[];
  symbols: NodeKind[];
  lines: EdgeKind[];
  external: boolean;
}

interface Props {
  graph: Graph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onCrumbs?: (crumbs: Crumb[]) => void;
  onReady?: (ctrl: MapController) => void;
  onKey?: (key: MapKey) => void;
  insetBottom?: number; // px covered by an overlay at the bottom (the key): fits keep content above it
  insetRight?: number; // px covered by the details panel on the right
  lens?: "structure" | "health"; // Health: tiles coloured by findings per 1,000 lines
  findings?: Finding[] | null; // open findings (Health lens, hover cards)
  onAction?: (kind: NodeAction, id: string) => void;
  storageKey?: string; // remembers the camera per repository for this browser tab
}

// ---- tuning -----------------------------------------------------------------------------------------
const OPEN_AREA: [number, number] = [0.3, 0.48]; // share of the screen over which a box opens while zooming
const OPEN_SPAN: [number, number] = [0.72, 0.84]; // …or share of the width/height (long boxes)
const OPEN_AT = 0.55; // at rest a box settles open once it was this open (and closed below CLOSE_AT)
const CLOSE_AT = 0.45;
const GLIDE_MS = 65; // time constant of the camera glide
const RESUME_MS = 40; // how fast a settled box catches up with the zoom again
const SETTLE_MS = 85; // how fast a box finishes opening/closing after you stop
const SCALE_QUIET_MS = 180; // zoom counts as "still going" this long after the last scale change
const MAX_ZOOM = 8;
const MAX_CHIP = 30; // px: symbol chips stop growing here (deeper zoom shows a card instead)
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
let SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"; // replaced by the app's font
const INK = "#a9b3c4"; // relationships at rest: one calm neutral
const INK_FOCUS = "#d6deeb";
const ACCENT = "#5aa9ff"; // selection (the app accent)
const HOVER_RING = "#c9d3e3";
const RARE_KINDS = new Set<string>(["extends", "implements", "exposes", "queries"]);
const LINE_BUDGET = 10; // folder/file links shown at full strength at rest (more taper off, the rest on focus)
const VEIL = 0.3; // how much a selection dims everything else

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const boxRadius = (sw: number, sh: number) => Math.min(14, Math.max(4, Math.min(sw, sh) * 0.06));
const sans = (weight: number, size: number): FontSpec => ({ weight, size, family: SANS });
const mono = (weight: number, size: number): FontSpec => ({ weight, size, family: MONO });

/** CSS-style cubic-bezier easing. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      const d = dx(t);
      if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return sy(clamp(t, 0, 1));
  };
}
const EASE_FLY = cubicBezier(0.25, 0.1, 0.25, 1);

interface View {
  k: number;
  x: number;
  y: number;
}

interface NodeState {
  n: MapNode;
  vis: number; // weight for relationships and picking: product of the ancestors' openness
  da: number; // drawing alpha of body and text: children appear once their parent is clearly opening
  t: number; // shown openness (0 = tile, 1 = open frame); 0 for leaves
  sx: number; // screen rect (top-left, size)
  sy: number;
  sw: number;
  sh: number;
  onScreen: boolean;
  nameHidden: boolean; // its name was shortened or moved to a pill: the tooltip shows it in full
}

interface Label {
  x: number;
  y: number;
  w: number;
  h: number;
  pill: boolean;
  area: number; // pills: size of their tile (bigger tiles win collisions)
  draw: () => void;
}

interface Anchor {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

interface Pt {
  x: number;
  y: number;
}

interface Curve {
  key: string;
  a: NodeState;
  b: NodeState;
  p: Pt;
  c: Pt;
  q: Pt;
  color: string;
  alpha: number;
  width: number;
  dash: number[];
  arrow: boolean;
  touched: boolean;
  sel: boolean; // touched by the selection (drawn over the veil, glints)
  inA: boolean;
  inB: boolean;
  n: number; // code-level relationships merged into this line
  kinds: Map<string, number>;
  samples: [string, string][]; // a few examples, for the line's tooltip
  sign: number; // bow side and width (kept when its ends are spread along a side)
  mul: number;
}

interface Health {
  bin: number;
  count: number;
  worst: string;
}

const SEVERITY_W: Record<string, number> = { critical: 10, high: 5, medium: 2, low: 0.7, info: 0.1 };
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
const softSeverity = (sev: string) => (sev === "critical" || sev === "high" ? FOCUS_BOTH : FOCUS_OUT);

interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
  id: string;
  anc: string[];
}

interface Obstacles {
  cell: number;
  grid: Map<string, Obstacle[]>;
}

type LayoutState =
  | { state: "idle" }
  | { state: "running"; items: number }
  | { state: "waiting" }
  | { state: "error"; message: string };

interface Debug {
  p50: number;
  p95: number;
  boxes: number;
  half: number;
  settled: boolean;
  k: number;
}

export function MapCanvas({
  graph,
  selected,
  onSelect,
  onCrumbs,
  onReady,
  onKey,
  insetBottom = 0,
  insetRight = 0,
  lens = "structure",
  findings = null,
  onAction,
  storageKey = "",
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<LayoutState>({ state: "idle" });
  const [tip, setTip] = useState<{ x: number; y: number; node?: MapNode; edge?: Curve } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: MapNode } | null>(null);
  const [debug, setDebug] = useState<Debug | null>(null);
  const [focusHint, setFocusHint] = useState(false);

  // Everything the frame loop needs lives in one mutable ref (no React re-render per frame).
  const S = useRef({
    model: null as MapModel | null,
    target: zoomIdentity as ZoomTransform,
    view: { k: 1, x: 0, y: 0 } as View,
    glide: true,
    anchor: null as Pt | null, // zoom focus point (the cursor for wheel zoom)
    w: 0,
    h: 0,
    dpr: 1,
    frame: 0 as number, // pending frame id (0 = none)
    frameByTimer: false, // pending frame was scheduled with setTimeout (hidden tab), not requestAnimationFrame
    lastT: 0,
    lastScaleAt: 0,
    flying: false,
    held: false, // a mouse button / finger is down on the map
    reduced: false, // prefers-reduced-motion
    states: new Map<string, NodeState>(),
    anim: new Map<string, { shown: number; open: boolean; seen: number }>(),
    labels: [] as Label[],
    curves: [] as Curve[],
    curveChoice: new Map<string, { sign: number; mul: number; skip: boolean }>(),
    mixCache: new Map<string, string>(),
    hover: null as string | null,
    hoverTitle: false, // the hover is on an open box's title band
    selected: null as string | null,
    selProp: null as string | null,
    selAt: 0, // when the current selection was made (ring grow-in, glint)
    emphSel: 0, // eased 0..1: how much the selection veils the rest
    emphHov: 0,
    pulse: null as { id: string; t0: number; count: number } | null,
    subtrees: new Map<string, Set<string>>(),
    classBorder: new Map<string, string>(),
    ptr: null as Pt | null,
    tipShown: false,
    focusHint: false,
    crumbKey: "",
    crumbIds: [] as string[],
    zoom: null as ZoomBehavior<HTMLCanvasElement, unknown> | null,
    seq: 0,
    homeK: 0,
    homed: false, // home view applied (needs a real canvas size)
    revealed: false, // canvas faded in after its first frame
    drawError: "",
    frameMs: [] as number[],
    dbg: { boxes: 0, half: 0, settled: true },
    insetBottom: 0,
    insetRight: 0,
    atHome: false, // camera still on the overview it was placed at (no user move yet)
    preview: null as string | null, // search result being looked at (ring, no camera move)
    lens: "structure" as "structure" | "health",
    lensT: 0, // eased 0..1 toward the Health colours
    findings: null as Finding[] | null,
    health: new Map<string, Health>(),
    tags: [] as { x: number; y: number; w: number; h: number; a: string; b: string; far: string }[],
    hoverEdge: null as string | null,
    atRest: false, // camera and boxes settled: shapes snap to device pixels
    storageKey: "",
    layoutKey: "",
    menuOpen: false,
  });
  const cb = useRef({ onSelect, onCrumbs, onReady, onKey, onAction });
  useEffect(() => {
    cb.current = { onSelect, onCrumbs, onReady, onKey, onAction };
  });

  useEffect(() => {
    S.current.lens = lens;
    api.current.requestDraw();
  }, [lens]);

  useEffect(() => {
    S.current.findings = findings;
    api.current.computeHealth();
    api.current.requestDraw();
  }, [findings]);

  useEffect(() => {
    S.current.storageKey = storageKey;
  }, [storageKey]);

  useEffect(() => {
    S.current.insetBottom = insetBottom;
    // the key reports its height after the first placement: re-place an untouched overview so it fits above
    if (S.current.atHome) api.current.goHome();
  }, [insetBottom]);

  useEffect(() => {
    S.current.insetRight = insetRight;
    api.current.requestDraw();
  }, [insetRight]);

  useEffect(() => {
    const s = S.current;
    if (selected !== s.selected) s.selAt = performance.now();
    s.selected = selected;
    s.selProp = selected;
    if (selected) setTimeout(() => api.current.ensureVisible(selected), 60);
    api.current.requestDraw();
  }, [selected]);

  // ---- frame scheduling --------------------------------------------------------------------------
  function requestDraw() {
    const s = S.current;
    if (s.frame) return;
    // animation frames pause in hidden tabs; draw anyway so state stays correct
    const run = () => {
      s.frame = 0;
      draw();
    };
    s.frameByTimer = document.visibilityState !== "visible";
    s.frame = s.frameByTimer ? (setTimeout(run, 0) as unknown as number) : requestAnimationFrame(run);
  }

  // ---- geometry helpers ----------------------------------------------------------------------------
  function toScreen(v: View, r: MapNode["rect"]) {
    const sx = (r.x - r.w / 2) * v.k + v.x;
    const sy = (r.y - r.h / 2) * v.k + v.y;
    const sw = r.w * v.k;
    const sh = r.h * v.k;
    if (!S.current.atRest) return { sx, sy, sw, sh };
    // at rest, edges land on whole device pixels (and 1 px borders on half pixels): crisp hairlines
    const d = S.current.dpr;
    const x1 = Math.round(sx * d) / d, y1 = Math.round(sy * d) / d;
    const x2 = Math.round((sx + sw) * d) / d, y2 = Math.round((sy + sh) * d) / d;
    return { sx: x1 + 0.5 / d, sy: y1 + 0.5 / d, sw: x2 - x1 - 1 / d, sh: y2 - y1 - 1 / d };
  }

  /** The part of the canvas not covered by overlays (details panel, key). */
  function visibleRect() {
    const s = S.current;
    const right = s.insetRight < s.w * 0.6 ? s.insetRight : 0;
    const bottom = s.insetBottom < s.h * 0.35 ? s.insetBottom : 0;
    return { x: 0, y: 0, w: s.w - right, h: s.h - bottom };
  }

  /** How open a box should be for its current size on screen (continuous). */
  function openness(n: MapNode, sw: number, sh: number, forced: boolean): number {
    if (!n.box) return 0;
    if (forced) return 1;
    const s = S.current;
    // measured against the part of the map you can see (not the key or the details panel), so a box flown
    // into always opens
    const vr = visibleRect();
    const area = (sw * sh) / Math.max(1, vr.w * vr.h);
    const span = Math.max(sw / Math.max(1, vr.w), sh / Math.max(1, vr.h));
    // the overview always starts closed: nothing opens until you zoom in past the home view
    const gate = smooth(s.homeK, s.homeK * 1.2, s.view.k);
    return gate * Math.max(smooth(OPEN_AREA[0], OPEN_AREA[1], area), smooth(OPEN_SPAN[0], OPEN_SPAN[1], span));
  }

  function subtree(id: string | null): Set<string> | null {
    const s = S.current;
    if (!id || !s.model?.nodes.has(id)) return null;
    let set = s.subtrees.get(id);
    if (!set) {
      set = new Set<string>();
      const walk = (x: string) => {
        set!.add(x);
        for (const c of s.model!.nodes.get(x)!.children) walk(c);
      };
      walk(id);
      if (s.subtrees.size > 64) s.subtrees.clear();
      s.subtrees.set(id, set);
    }
    return set;
  }

  /** The node itself if visible, otherwise the closed tile that currently stands in for it. */
  function standIn(id: string): NodeState | null {
    const s = S.current;
    const n = s.model?.nodes.get(id);
    if (!n) return null;
    return [id, ...n.ancestors].map((x) => s.states.get(x)).find((st) => st && st.vis > 0.3 && (st.t < 0.5 || !st.n.box || st.n.id === id)) ?? null;
  }

  // ---- the frame ------------------------------------------------------------------------------------
  function draw() {
    const s = S.current;
    try {
      const t0 = performance.now();
      renderFrame();
      if (s.homed) {
        s.frameMs.push(performance.now() - t0);
        if (s.frameMs.length > 120) s.frameMs.shift();
      }
      // a frame that worked clears an old error chip
      if (s.drawError) {
        s.drawError = "";
        setLayout({ state: "idle" });
      }
    } catch (err) {
      // show the failure instead of a silently blank map (reported once per message)
      const msg = err instanceof Error ? err.message : String(err);
      if (s.drawError !== msg) {
        s.drawError = msg;
        console.error("[code map] drawing failed", err);
        setLayout({ state: "error", message: `drawing failed: ${msg}` });
      }
    }
  }

  function renderFrame() {
    const s = S.current;
    const canvas = canvasRef.current;
    const model = s.model;
    if (!canvas || !model || !s.homed) return; // nothing sensible to draw before the camera is placed
    if (!fitCanvas()) return; // also catches size changes a ResizeObserver missed
    const ctx = canvas.getContext("2d")!;
    const now = performance.now();
    const dt = s.lastT ? Math.min(50, now - s.lastT) : 16;
    s.lastT = now;
    const visible = document.visibilityState === "visible";
    const animate = visible && !s.reduced;

    // -- camera: ease the drawn view toward d3's target, zooming about the anchor (the cursor for wheel
    //    zoom), in log space so every notch feels the same; time-based so 60 Hz and 144 Hz feel alike
    const tv = s.target;
    const v = s.view;
    const a = s.glide && animate ? 1 - Math.exp(-dt / GLIDE_MS) : 1;
    const anc = s.anchor ?? { x: s.w / 2, y: s.h / 2 };
    const wvx = (anc.x - v.x) / v.k, wvy = (anc.y - v.y) / v.k;
    const wtx = (anc.x - tv.x) / tv.k, wty = (anc.y - tv.y) / tv.k;
    const lk = Math.log(v.k) + (Math.log(tv.k) - Math.log(v.k)) * a;
    const nk = Math.exp(lk);
    const wx = wvx + (wtx - wvx) * a;
    const wy = wvy + (wty - wvy) * a;
    const moved = Math.abs(nk - v.k) > 1e-6 || Math.abs(anc.x - wx * nk - v.x) > 0.01 || Math.abs(anc.y - wy * nk - v.y) > 0.01;
    v.k = nk;
    v.x = anc.x - wx * nk;
    v.y = anc.y - wy * nk;
    const camSettled = Math.abs(lk - Math.log(tv.k)) < 1e-3 && Math.abs(wx - wtx) * nk < 0.3 && Math.abs(wy - wty) * nk < 0.3;
    if (camSettled) {
      v.k = tv.k;
      v.x = tv.x;
      v.y = tv.y;
    }
    const scaling = s.flying || now - s.lastScaleAt < SCALE_QUIET_MS || Math.abs(lk - Math.log(tv.k)) > 1e-3;
    s.atRest = camSettled && !scaling;
    // Health lens colours ease in and out (about 350 ms)
    const lensGoal = s.lens === "health" ? 1 : 0;
    if (s.lensT !== lensGoal) {
      s.lensT = animate ? s.lensT + (lensGoal - s.lensT) * (1 - Math.exp(-dt / 110)) : lensGoal;
      if (Math.abs(s.lensT - lensGoal) < 0.01) s.lensT = lensGoal;
    }
    const lensMoving = s.lensT !== lensGoal;

    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, s.w, s.h);
    drawGrid(ctx, v);

    // -- pass 0: openness (continuous while zooming, settled at rest) and visibility
    const states = new Map<string, NodeState>();
    const margin = 80;
    let pending = false; // something is still easing
    let half = 0;
    const visit = (id: string, vis: number, da: number, forced: boolean) => {
      const n = model.nodes.get(id)!;
      const r = toScreen(v, n.rect);
      const onScreen = r.sx + r.sw > -margin && r.sx < s.w + margin && r.sy + r.sh > -margin && r.sy < s.h + margin;
      let t = 0;
      if (n.box && onScreen) {
        const raw = openness(n, r.sw, r.sh, forced);
        let an = s.anim.get(id);
        const isNew = !an;
        if (!an) {
          an = { shown: raw, open: raw >= 0.5, seen: now };
          s.anim.set(id, an);
        }
        an.open = an.open ? raw > CLOSE_AT : raw >= OPEN_AT;
        const goal = scaling ? raw : an.open ? 1 : 0;
        if (isNew || !animate) an.shown = goal;
        else if (scaling) an.shown += (raw - an.shown) * (1 - Math.exp(-dt / RESUME_MS));
        else if (!s.held) an.shown += (goal - an.shown) * (1 - Math.exp(-dt / SETTLE_MS));
        if (Math.abs(an.shown - goal) < 0.004) an.shown = goal;
        else if (!s.held) pending = true;
        an.seen = now;
        t = an.shown;
        if (t > 0.05 && t < 0.95) half++;
      }
      states.set(id, { n, vis, da, t, ...r, onScreen, nameHidden: false });
      if (n.box && t > 0.005 && onScreen) {
        const cda = da * smooth(0.25, 0.65, t);
        for (const c of n.children) visit(c, vis * t, cda, false);
      }
    };
    for (const r of model.roots) visit(r, 1, 1, model.roots.length === 1 || r === model.dominant);
    s.states = states;
    if (s.anim.size > states.size * 3 + 200) for (const [id, an] of s.anim) if (now - an.seen > 2000) s.anim.delete(id);

    // -- emphasis: the selection veils the rest (eased in and out); hover only lights lines
    const selSt = s.selected ? standIn(s.selected) : null;
    const ease = (cur: number, goal: number) => {
      if (!animate) return goal;
      const tau = goal > cur ? 60 : 110;
      const nv = cur + (goal - cur) * (1 - Math.exp(-dt / tau));
      if (Math.abs(nv - goal) < 0.01) return goal;
      pending = true;
      return nv;
    };
    s.emphSel = ease(s.emphSel, selSt ? 1 : 0);
    s.emphHov = ease(s.emphHov, s.hover && s.hover !== s.selected ? 1 : 0);

    const boxes = [...states.values()].filter((st) => st.n.box && st.onScreen).sort((x, y) => x.n.depth - y.n.depth);
    const leaves = [...states.values()].filter((st) => !st.n.box && st.onScreen && st.da > 0.01);

    // -- pass 1: open surfaces + header strips
    for (const st of boxes) if (st.t > 0.005 && st.da > 0.01) drawFrameFill(ctx, st);
    // -- pass 2: relationships at rest (under the tiles); focused ones are kept for later
    s.curves = buildCurves(ctx, model, states, scaling);
    for (const c of s.curves) if (!c.touched) strokeCurve(ctx, c, false);
    // -- pass 3: box bodies + borders, then symbol chips
    for (const st of boxes) if (st.da > 0.01) drawBox(ctx, st);
    for (const st of leaves) drawChip(ctx, st);
    // -- pass 4: resting lines plug visibly into their tiles
    for (const c of s.curves) if (!c.touched) drawSockets(ctx, c);
    // -- pass 5: labels
    drawLabels();
    // -- pass 6: the selection veils the rest; its world is redrawn on top
    if (s.emphSel > 0.01 && selSt) drawVeil(ctx, selSt, states);
    // -- pass 7: focused relationships, continuous and on top; the line under the pointer too
    for (const c of s.curves) if (c.touched) strokeCurve(ctx, c, true);
    const hovered = s.hoverEdge ? s.curves.find((c) => c.key === s.hoverEdge) : undefined;
    if (hovered && !hovered.touched) strokeCurve(ctx, { ...hovered, color: INK_FOCUS, alpha: Math.max(0.85, hovered.alpha), width: hovered.width + 1 }, true);
    if (drawGlint(ctx, now)) pending = true;
    // -- pass 8: rings and the landing pulse
    if (s.selected) drawRing(ctx, s.selected, true, now);
    if (s.hover && s.hover !== s.selected) drawRing(ctx, s.hover, false, now);
    if (s.preview && s.preview !== s.selected) drawRing(ctx, s.preview, false, now);
    if (drawPulse(ctx, now)) pending = true;
    drawTags(ctx);
    if (lensMoving) pending = true;

    updateCrumbs(model, states);
    if (moved) refreshHover();
    const hint = s.emphSel > 0.5 && s.curves.some((c) => c.sel);
    if (hint !== s.focusHint) {
      s.focusHint = hint;
      setFocusHint(hint);
    }
    if (!s.revealed) {
      s.revealed = true;
      canvas.style.opacity = "1";
    }
    s.dbg = { boxes: boxes.length, half, settled: camSettled && !pending && !scaling };
    if (!camSettled || pending || scaling) requestDraw();
  }

  function drawGrid(ctx: CanvasRenderingContext2D, v: View) {
    // dots every 2^n world units, chosen so they sit 22–44 px apart; the finer level fades in smoothly.
    // Snapped to whole pixels so the grid does not shimmer while panning.
    const base = Math.pow(2, Math.floor(Math.log2(22 / v.k)));
    for (const [step, alpha] of [
      [base * 2, 0.12],
      [base, 0.12 * smooth(22, 44, base * v.k * 2)],
    ] as const) {
      const px = step * v.k;
      if (px < 10 || alpha < 0.01) continue;
      ctx.fillStyle = `rgba(150,165,190,${alpha})`;
      const x0 = ((v.x % px) + px) % px;
      const y0 = ((v.y % px) + px) % px;
      // 2×2 device-pixel dots on whole device pixels: crisp at any display scaling, no shimmer while panning
      const d = S.current.dpr;
      const sz = 2 / d;
      // one path, one fill: ~3× faster than a fillRect per dot (thousands of dots per frame)
      ctx.beginPath();
      for (let x = x0; x < S.current.w; x += px) for (let y = y0; y < S.current.h; y += px) ctx.rect(Math.round(x * d) / d - sz / 2, Math.round(y * d) / d - sz / 2, sz, sz);
      ctx.fill();
    }
  }

  function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, w, h, rr);
      return;
    }
    // older browsers: same shape from arcs
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, r);
  }

  /** A box bigger than the screen is the room you are in: its edges and strip fade instead of stacking up
   *  as rails along the screen. */
  function roomFade(st: NodeState) {
    const s = S.current;
    return 1 - smooth(1.1, 1.8, Math.max(st.sw / s.w, st.sh / s.h));
  }

  /** Height (px) of an open box's header strip: its title band plus the top of its padding. */
  function stripPx(n: MapNode) {
    return ((n.rect.header ?? 14) + (n.rect.pad ?? 10) * 0.75) * S.current.view.k;
  }

  /** The open surface, drawn fully (the tile body then fades away over it: one card, never a double image),
   *  with a faint header strip under the title once the box is clearly open. */
  function drawFrameFill(ctx: CanvasRenderingContext2D, st: NodeState) {
    const { n, sx, sy, sw, sh } = st;
    const radius = boxRadius(sw, sh);
    ctx.globalAlpha = st.da;
    roundRect(ctx, sx, sy, sw, sh, radius);
    ctx.fillStyle = n.pal.frame;
    ctx.fill();
    const strip = stripPx(n);
    const sa = st.da * smooth(0.3, 0.7, st.t) * roomFade(st);
    if (strip >= 12 && sa > 0.01) {
      ctx.save();
      roundRect(ctx, sx, sy, sw, sh, radius);
      ctx.clip();
      ctx.globalAlpha = sa;
      ctx.fillStyle = n.pal.band;
      ctx.fillRect(sx, sy, sw, strip);
      ctx.fillStyle = n.pal.bandLine;
      ctx.fillRect(sx, sy + strip - 1, sw, 1);
      ctx.restore();
    }
  }

  function borderColor(n: MapNode, open: boolean): string {
    if (n.kind !== "class") return open ? n.pal.frameBorder : n.pal.tileBorder;
    // classes: border leans toward the class colour, so a class reads differently from a file
    const key = `${n.id}|${open ? 1 : 0}`;
    let c = S.current.classBorder.get(key);
    if (!c) {
      c = mixOklab(open ? n.pal.frameBorder : n.pal.tileBorder, KIND_STYLE.class.color, 0.4);
      S.current.classBorder.set(key, c);
    }
    return c;
  }

  /** Tile body (fading as the box opens), one border morphing from the tile's to the frame's, kind cues, and
   *  the box's labels. */
  function drawBox(ctx: CanvasRenderingContext2D, st: NodeState) {
    const { n, sx, sy, sw, sh } = st;
    if (sw < 2 || sh < 2) return;
    const radius = boxRadius(sw, sh);
    const e = smooth(0.15, 0.7, st.t);
    const bodyA = st.da * (1 - e);
    if (bodyA > 0.01) {
      ctx.globalAlpha = bodyA;
      if (sw > 36) {
        // soft shadow lifts tiles off the surface
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = Math.min(22, sw * 0.08);
        ctx.shadowOffsetY = Math.min(6, sw * 0.02);
      }
      const g = ctx.createLinearGradient(0, sy, 0, sy + sh);
      const hl = healthTile(n);
      g.addColorStop(0, hl ? hl.top : n.pal.tileTop);
      g.addColorStop(1, hl ? hl.bottom : n.pal.tileBottom);
      roundRect(ctx, sx, sy, sw, sh, radius);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      // light top edge: a subtle "glass" highlight
      if (sh > 24) {
        ctx.beginPath();
        ctx.moveTo(sx + radius, sy + 1);
        ctx.lineTo(sx + sw - radius, sy + 1);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.stroke();
      }
    }
    const room = roomFade(st);
    if (room > 0.01) {
      ctx.lineWidth = 1;
      if (n.neutral) ctx.setLineDash([4, 3]);
      if (e < 0.99) {
        ctx.globalAlpha = st.da * room * (1 - e) * 0.9;
        roundRect(ctx, sx, sy, sw, sh, radius);
        ctx.strokeStyle = borderColor(n, false);
        ctx.stroke();
      }
      if (e > 0.01) {
        ctx.globalAlpha = st.da * room * e * 0.75;
        roundRect(ctx, sx, sy, sw, sh, radius);
        ctx.strokeStyle = borderColor(n, true);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // a file shows a small folded corner, so files read differently from folders before you zoom in
      if (n.kind === "file" && sw > 28 && sh > 20) {
        const f = Math.min(9, sw * 0.08);
        ctx.globalAlpha = st.da * room * (0.55 + 0.25 * (1 - e));
        ctx.beginPath();
        ctx.moveTo(sx + sw - radius - f, sy);
        ctx.lineTo(sx + sw - radius, sy);
        ctx.lineTo(sx + sw - radius, sy + f);
        ctx.closePath();
        ctx.fillStyle = borderColor(n, e > 0.5);
        ctx.fill();
      }
    }
    // Health lens: a findings mark (dot + count) in the corner of tiles big enough to hold it
    const h = S.current.health.get(n.id);
    if (h && h.count > 0 && S.current.lensT > 0.5 && st.t < 0.3 && sw >= 90 && sh >= 40) {
      ctx.globalAlpha = st.da * (S.current.lensT - 0.5) * 2 * (1 - e);
      const label = h.count > 99 ? "99+" : String(h.count);
      const f = sans(600, 11);
      const tw = measure(ctx, label, f);
      const bx = sx + sw - tw - 26, by = sy + 8;
      roundRect(ctx, bx, by, tw + 18, 16, 8);
      ctx.fillStyle = "rgba(15,18,24,0.7)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx + 7, by + 8, 3, 0, Math.PI * 2);
      ctx.fillStyle = softSeverity(h.worst);
      ctx.fill();
      ctx.font = fontOf(f);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = MAP_INK;
      ctx.fillText(label, bx + 13, by + 8.5);
    }
    if (st.t < 0.3) queueTileName(ctx, st);
    if (st.t > 0.05) queueFrameTitle(ctx, st);
  }

  /** Tile colours in the Health lens: blended from the area colours as the lens eases in. */
  function healthTile(n: MapNode): { top: string; bottom: string } | null {
    const s = S.current;
    if (s.lensT <= 0.01 || n.neutral) return null;
    const bin = s.health.get(n.id)?.bin ?? 0;
    const t = Math.round(s.lensT * 10) / 10;
    return { top: mixColor(n.pal.tileTop, HEALTH_TILES[bin].top, t), bottom: mixColor(n.pal.tileBottom, HEALTH_TILES[bin].bottom, t) };
  }

  /** Findings → per node: count, worst severity, and (for boxes) a bin by weighted findings per 1,000 lines.
   *  Test code is left out (findings there are about tests, not product health). */
  function computeHealth() {
    const s = S.current;
    const model = s.model;
    s.health = new Map();
    if (!model || !s.findings) return;
    const byPath = new Map<string, MapNode>();
    for (const n of model.nodes.values()) if (n.kind === "file") byPath.set(n.path, n);
    const boxes = [...model.nodes.values()].filter((n) => n.box && n.path).sort((a, b) => b.path.length - a.path.length);
    const weight = new Map<string, number>();
    const count = new Map<string, number>();
    const worst = new Map<string, string>();
    for (const f of s.findings) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      const target = model.nodes.get(f.node_id) ?? byPath.get(f.path) ?? boxes.find((b) => dir === b.path || dir.startsWith(`${b.path}/`));
      if (!target || target.test) continue;
      const w = (SEVERITY_W[f.severity] ?? 0.1) * (f.confidence || 0.7);
      for (const id of [target.id, ...target.ancestors]) {
        weight.set(id, (weight.get(id) ?? 0) + w);
        count.set(id, (count.get(id) ?? 0) + 1);
        const cur = worst.get(id);
        if (!cur || SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(cur)) worst.set(id, f.severity);
      }
    }
    // lines per box: the files inside
    const lines = new Map<string, number>();
    for (const n of model.nodes.values()) {
      if (n.kind !== "file") continue;
      for (const id of [n.id, ...n.ancestors]) lines.set(id, (lines.get(id) ?? 0) + Math.max(0, n.lines));
    }
    for (const n of model.nodes.values()) {
      const c = count.get(n.id) ?? 0;
      if (!n.box && !c) continue;
      const density = (weight.get(n.id) ?? 0) / ((lines.get(n.id) ?? 0) / 1000 + 0.15);
      const bin = HEALTH_BINS.findIndex((b) => density < b);
      s.health.set(n.id, { bin: bin < 0 ? HEALTH_BINS.length : bin, count: c, worst: worst.get(n.id) ?? "" });
    }
  }

  /** The closed tile's name (and summary), centred on the part of the tile you can see. Long names shrink a
   *  little, then shorten. */
  function queueTileName(ctx: CanvasRenderingContext2D, st: NodeState) {
    const s = S.current;
    const { n, sx, sy, sw, sh } = st;
    const alpha = st.da * (1 - smooth(0, 0.3, st.t));
    if (alpha < 0.02) return;
    const vx1 = Math.max(sx, 8), vy1 = Math.max(sy, 8);
    const vx2 = Math.min(sx + sw, s.w - 8), vy2 = Math.min(sy + sh, s.h - 8);
    const vw = vx2 - vx1, vh = vy2 - vy1;
    // size follows the tile's own size (never the name's length), so equal tiles carry equal names
    let size = Math.min(22, sw / 7, sh / 3.2);
    // mid-sized tiles keep their name inside at a small but legible size; only tiny tiles use a pill
    if (size < 11 && sw >= 48 && sh >= 22) size = 10.5;
    if (size >= 10.5 && vw >= 44 && vh >= size * 1.6) {
      const want = measure(ctx, n.label, sans(600, size));
      if (want > vw - 16) size = Math.max(Math.min(size, 11), size * 0.8, Math.min(size, (size * (vw - 16)) / want));
      const font = sans(600, size);
      const name = fitSmart(ctx, n.label, font, vw - 16);
      if (!name) return;
      if (name !== n.label) st.nameHidden = true;
      const subFont = sans(400, Math.max(11, size * 0.68));
      const sub = size >= 14 && sh > size * 3.4 && vh > size * 3 ? fitParts(ctx, n.summary, subFont, vw - 16) : "";
      const cx = (vx1 + vx2) / 2;
      const cy = (vy1 + vy2) / 2 - (sub ? size * 0.55 : 0);
      const w = measure(ctx, name, font);
      S.current.labels.push({
        x: cx - w / 2,
        y: cy - size / 2,
        w,
        h: size * (sub ? 2.4 : 1.2),
        pill: false,
        area: 0,
        draw: () => {
          ctx.globalAlpha = alpha;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = fontOf(font);
          ctx.fillStyle = n.pal.name;
          ctx.fillText(name, cx, cy);
          if (sub) {
            ctx.font = fontOf(subFont);
            ctx.fillStyle = n.pal.sub;
            ctx.fillText(sub, cx, cy + size * 1.15);
          }
        },
      });
    } else if (sw > 6 && alpha > 0.3) {
      st.nameHidden = true; // the pill may lose a collision; the tooltip always has the name
      queuePill(ctx, n.label, sx + sw / 2, sy + sh + 3, sw * sh, alpha);
    }
  }

  function queuePill(ctx: CanvasRenderingContext2D, label: string, cx: number, top: number, area: number, alpha: number) {
    const font = sans(600, 11);
    const text = fitSmart(ctx, label, font, 160);
    if (!text) return;
    const tw = measure(ctx, text, font);
    S.current.labels.push({
      x: cx - tw / 2 - 5,
      y: top,
      w: tw + 10,
      h: 16,
      pill: true,
      area,
      draw: () => {
        ctx.globalAlpha = alpha * 0.95;
        roundRect(ctx, cx - tw / 2 - 5, top, tw + 10, 16, 6);
        ctx.fillStyle = "rgba(15,18,24,0.88)";
        ctx.fill();
        ctx.font = fontOf(font);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = MAP_INK;
        ctx.fillText(text, cx, top + 8.5);
      },
    });
  }

  /** An open box's title in its header strip: name left, contents right, kept inside the visible part. One
   *  size per sibling group. */
  function queueFrameTitle(ctx: CanvasRenderingContext2D, st: NodeState) {
    const s = S.current;
    const { n, sx, sy, sw } = st;
    const alpha = st.da * smooth(0.05, 0.3, st.t);
    if (alpha < 0.02) return;
    const strip = stripPx(n);
    if (strip < 12) return;
    const size = clamp(n.bandWorld * s.view.k * 0.5, 13, 16);
    const ty = sy + strip / 2;
    if (ty < -size || ty > s.h + size) return;
    const visL = Math.max(sx, 0) + 12;
    const visR = Math.min(sx + sw, s.w) - 12;
    if (visR - visL < 40) return;
    const font = sans(600, size);
    const label = n.kind === "class" ? `◆ ${n.label}` : n.label;
    const title = fitSmart(ctx, label, font, 0.6 * (visR - visL));
    if (!title) return;
    const titleW = measure(ctx, title, font);
    const tx = Math.max(sx + 12, Math.min(visL, visR - titleW));
    const subFont = sans(400, 12);
    const sub = fitParts(ctx, n.summary, subFont, visR - visL - titleW - 24);
    S.current.labels.push({
      x: tx,
      y: ty - size / 2,
      w: titleW,
      h: size,
      pill: false,
      area: 0,
      draw: () => {
        ctx.globalAlpha = alpha;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        ctx.font = fontOf(font);
        ctx.fillStyle = n.pal.title;
        ctx.fillText(title, tx, ty);
        // the title band is clickable: underline it under the pointer
        if (S.current.hover === n.id && S.current.hoverTitle) ctx.fillRect(tx, ty + size * 0.62, titleW, 1);
        if (sub) {
          ctx.font = fontOf(subFont);
          ctx.fillStyle = MAP_MUTED;
          ctx.textAlign = "right";
          ctx.fillText(sub, visR, ty);
        }
      },
    });
  }

  function drawLabels() {
    const s = S.current;
    const fixed = s.labels.filter((l) => !l.pill);
    const pills = s.labels.filter((l) => l.pill).sort((a, b) => b.area - a.area);
    for (const l of fixed) l.draw();
    const taken = [...fixed];
    const hit = (a: Label, b: Label) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2;
    for (const p of pills) {
      if (taken.some((t) => hit(t, p))) continue;
      p.draw();
      taken.push(p);
    }
    s.labels = [];
  }

  // ---- symbols ------------------------------------------------------------------------------------------
  /** Chip geometry (screen space), left-aligned in its layout slot. Chips stop growing at MAX_CHIP; deeper
   *  zoom fades a card in over the whole slot. Far away a chip is a dot at the chip's own mark. */
  function chipGeom(ctx: CanvasRenderingContext2D, st: NodeState) {
    const v = S.current.view;
    const r = st.n.rect;
    const slotX = (r.x - r.w / 2) * v.k + v.x;
    const slotY = (r.y - r.h / 2) * v.k + v.y;
    const slotW = r.w * v.k;
    const slotH = r.h * v.k;
    const ch = Math.min(CHIP_H * v.k, MAX_CHIP) * (st.n.inner ? 0.85 : 1);
    const size = clamp(ch * 0.5, 10, 13);
    const textW = measure(ctx, st.n.label, mono(400, size));
    const extra = st.n.isComponent ? size * 2.2 : 0;
    const cw = Math.max(ch, Math.min(Math.max(18 * v.k, slotW - 8 * v.k), textW + ch * 1.25 + 14 + extra));
    const x = slotX + Math.min(4 * v.k, 4);
    const cy = slotY + slotH / 2;
    const card = smooth(2.2 * ch, 2.8 * ch, slotH);
    return { ch, cw, x, y: cy - ch / 2, cy, size, ca: smooth(19, 23, ch), card, slotX, slotY, slotW, slotH };
  }

  /** A small shape per kind: ● function, ◆ class, ▶ endpoint, ▭ table, tag for a package. Private helpers get
   *  a hollow mark. */
  function drawGlyph(ctx: CanvasRenderingContext2D, n: MapNode, x: number, y: number, r: number, color: string) {
    ctx.beginPath();
    const big = r >= 3;
    switch (big ? n.kind : "function") {
      case "class":
        ctx.moveTo(x, y - r * 1.2);
        ctx.lineTo(x + r * 1.2, y);
        ctx.lineTo(x, y + r * 1.2);
        ctx.lineTo(x - r * 1.2, y);
        ctx.closePath();
        break;
      case "endpoint":
        ctx.moveTo(x - r * 0.8, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x - r * 0.8, y + r);
        ctx.closePath();
        break;
      case "table":
        ctx.rect(x - r, y - r * 0.8, r * 2, r * 1.6);
        break;
      case "dependency":
        ctx.moveTo(x - r, y);
        ctx.lineTo(x - r * 0.3, y - r * 0.9);
        ctx.lineTo(x + r, y - r * 0.9);
        ctx.lineTo(x + r, y + r * 0.9);
        ctx.lineTo(x - r * 0.3, y + r * 0.9);
        ctx.closePath();
        break;
      default:
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    if (n.priv && big) {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = color;
      ctx.stroke();
    } else {
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  function drawChip(ctx: CanvasRenderingContext2D, st: NodeState) {
    const s = S.current;
    const { n } = st;
    const g = chipGeom(ctx, st);
    if (g.slotX > s.w || g.slotY > s.h || g.slotX + g.slotW < 0 || g.slotY + g.slotH < 0) return;
    const pal = n.chip!;
    const base = st.da * (n.quiet ? 0.5 : 1);
    const dotR = clamp(g.ch * 0.15, 1.5, 3.5);
    if (g.ca < 1) {
      // far away: a small coloured dot exactly where the chip's own mark will be, growing into the chip
      ctx.globalAlpha = base * (1 - g.ca) * 0.85;
      ctx.beginPath();
      ctx.arc(g.x + g.ch * 0.5, g.cy, Math.max(1.5, dotR), 0, Math.PI * 2);
      ctx.fillStyle = pal.dot;
      ctx.fill();
    }
    if (g.ca <= 0) return;
    const chipA = base * g.ca * (1 - g.card);
    if (chipA > 0.01) {
      // one alpha for capsule, mark and name: a capsule is never blank
      ctx.globalAlpha = chipA;
      roundRect(ctx, g.x, g.y, g.cw, g.ch, g.ch / 2);
      ctx.fillStyle = pal.fill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(pal.stroke, n.priv ? 0.3 : 0.55);
      ctx.stroke();
      drawGlyph(ctx, n, g.x + g.ch * 0.5, g.cy, dotR, pal.dot);
      const font = mono(400, g.size);
      const room = g.cw - g.ch * 0.95 - (n.isComponent ? g.size * 2.2 : 0) - 6;
      const label = fitSmart(ctx, n.label, font, room);
      if (label !== n.label) st.nameHidden = true;
      if (label) {
        ctx.font = fontOf(font);
        ctx.fillStyle = n.priv ? MAP_MUTED : MAP_INK;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, g.x + g.ch * 0.85, g.cy + 0.5);
        if (n.isComponent) {
          // a React component: a small </> mark
          ctx.font = fontOf(mono(400, g.size * 0.8));
          ctx.fillStyle = withAlpha(pal.dot, 0.8);
          ctx.textAlign = "right";
          ctx.fillText("</>", g.x + g.cw - g.ch * 0.4, g.cy + 0.5);
        }
      }
    }
    if (g.card > 0.01) drawCard(ctx, st, g, base * g.ca * g.card);
    // a hub (called from many places in its file) shows how many instead of a fan of arrows
    if (n.hubIn > 0 && g.ch >= 15 && chipA > 0.3) {
      const r = 8;
      const bx = g.x + g.cw - 2, by = g.y + 1;
      ctx.globalAlpha = chipA;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = MAP_PANEL;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(pal.stroke, 0.8);
      ctx.stroke();
      ctx.font = fontOf(sans(600, 9));
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = MAP_INK;
      ctx.fillText(String(n.hubIn), bx, by + 0.5);
    }
    // Health lens: a soft ring on symbols with findings
    const h = s.health.get(n.id);
    if (h && h.count > 0 && s.lensT > 0.01 && g.ca > 0.5) {
      ctx.globalAlpha = s.lensT * st.da;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = softSeverity(h.worst);
      roundRect(ctx, g.x - 2, g.y - 2, g.cw + 4, g.ch + 4, g.ch / 2 + 2);
      ctx.stroke();
    }
  }

  /** Deep zoom: the symbol as a small card with its signature, line range and flags. */
  function drawCard(ctx: CanvasRenderingContext2D, st: NodeState, g: ReturnType<typeof chipGeom>, alpha: number) {
    const { n } = st;
    const pal = n.chip!;
    const v = S.current.view;
    const mx = Math.min(4 * v.k, 6);
    const my = Math.min(3 * v.k, 5);
    // a card is as big as what it says (not the whole slot), left-aligned and centred vertically
    const want = Math.max(
      measure(ctx, n.label, mono(600, 14)) + 52,
      n.detail ? measure(ctx, n.detail, mono(400, 11)) + 28 : 0,
      n.detail2 ? measure(ctx, n.detail2, mono(400, 11)) + 28 : 0,
      200,
    );
    const w = Math.max(40, Math.min(g.slotW - 2 * mx, want));
    const h = Math.max(24, Math.min(g.slotH - 2 * my, n.detail2 ? 80 : 62));
    const x = g.slotX + mx;
    const y = g.slotY + (g.slotH - h) / 2;
    ctx.globalAlpha = alpha;
    roundRect(ctx, x, y, w, h, Math.min(12, h * 0.25));
    ctx.fillStyle = pal.fill;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(pal.stroke, n.priv ? 0.35 : 0.6);
    ctx.stroke();
    const pad = 12;
    const name = mono(600, 14);
    drawGlyph(ctx, n, x + pad + 4, y + pad + 8, 4, pal.dot);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = fontOf(name);
    ctx.fillStyle = n.priv ? MAP_MUTED : MAP_INK;
    ctx.fillText(fitSmart(ctx, n.label, name, w - pad * 2 - 18), x + pad + 16, y + pad + 8.5);
    const small = mono(400, 11);
    ctx.font = fontOf(small);
    ctx.fillStyle = MAP_MUTED;
    let ly = y + pad + 28;
    for (const line of [n.detail, h >= 60 ? n.detail2 : ""]) {
      if (!line || ly > y + h - 8) continue;
      ctx.fillText(fitSmart(ctx, line, small, w - pad * 2), x + pad, ly);
      ly += 16;
    }
  }

  /** Where a line attaches on a node: a tile (lines then enter it a little), a chip's border, a card, or the
   *  chip's dot from far away. */
  function anchor(st: NodeState): Anchor {
    if (st.n.box) return { cx: st.sx + st.sw / 2, cy: st.sy + st.sh / 2, hw: st.sw / 2, hh: st.sh / 2 };
    const ctx = canvasRef.current!.getContext("2d")!;
    const g = chipGeom(ctx, st);
    if (g.card > 0.5) {
      const w = Math.min(g.slotW - 8, Math.max(200, g.cw + 40));
      const h = Math.min(g.slotH - 6, st.n.detail2 ? 80 : 62);
      return { cx: g.slotX + 4 + w / 2, cy: g.slotY + g.slotH / 2, hw: w / 2, hh: h / 2 };
    }
    if (g.ca < 0.5) {
      const r = clamp(g.ch * 0.15, 1.5, 3.5) + 3;
      return { cx: g.x + g.ch * 0.5, cy: g.cy, hw: r, hh: r };
    }
    return { cx: g.x + g.cw / 2, cy: g.cy, hw: g.cw / 2, hh: g.ch / 2 };
  }

  function clip(a: Anchor, dx: number, dy: number, pad: number) {
    // point where the ray from the centre along (dx, dy) leaves the (padded) rectangle
    const sx = dx === 0 ? Infinity : Math.max(0.5, a.hw + pad) / Math.abs(dx);
    const sy = dy === 0 ? Infinity : Math.max(0.5, a.hh + pad) / Math.abs(dy);
    const s = Math.min(sx, sy);
    return { x: a.cx + dx * s, y: a.cy + dy * s };
  }

  // ---- relationships ----------------------------------------------------------------------------------------
  function mixColor(a: string, b: string, t: number) {
    const cache = S.current.mixCache;
    const key = `${a}${b}${t}`;
    let c = cache.get(key);
    if (!c) {
      c = mixOklab(a, b, t);
      if (cache.size > 200) cache.clear();
      cache.set(key, c);
    }
    return c;
  }

  function buildCurves(ctx: CanvasRenderingContext2D, model: MapModel, states: Map<string, NodeState>, scaling: boolean): Curve[] {
    const s = S.current;
    const selSet = subtree(s.selected);
    const hovSet = s.hover !== s.selected ? subtree(s.hover) : null;
    const focusAny = !!(selSet || hovSet);
    // an open focused box keeps its own inside lines bright
    const openFocus = [s.selected, s.hover].map((id) => (id ? states.get(id) : undefined)).find((st) => st && st.n.box && st.t >= 0.5);
    const openSet = openFocus ? subtree(openFocus.n.id) : null;

    // Spread each code-level edge over the nodes that currently stand in for its ends. A node stands in
    // with weight vis·(1−t) (visible but not open); weights along an ancestor chain sum to ~1.
    // This runs every frame over every relationship, so it works on integer arrays built once with the model.
    const NN = model.byIndex.length;
    const wOf = new Float32Array(NN);
    for (const st of states.values()) {
      const w = st.n.box ? st.vis * (1 - st.t) : st.vis;
      if (w > 0.02) wOf[st.n.index] = w;
    }
    const flags = (set: Set<string> | null) => {
      if (!set) return null;
      const f = new Uint8Array(NN);
      for (const id of set) {
        const n = model.nodes.get(id);
        if (n) f[n.index] = 1;
      }
      return f;
    };
    const selF = flags(selSet);
    const hovF = flags(hovSet);
    const endsCache: (Int32Array | undefined)[] = new Array(NN);
    const ends = (i: number) => {
      let r = endsCache[i];
      if (!r) {
        const out: number[] = [];
        for (const j of model.chain[i]) if (wOf[j] > 0) out.push(j);
        endsCache[i] = r = Int32Array.from(out);
      }
      return r;
    };
    const K = model.kindNames.length;
    type Acc = { ai: number; bi: number; w: number; n: number; ext: number; out: boolean; inc: boolean; sel: boolean; hov: boolean; kinds: Int32Array; samples: number[] };
    const acc = new Map<number, Acc>();
    const { eSrc, eTgt, eKind, eExt } = model;
    for (let e = 0; e < eSrc.length; e++) {
      const si = eSrc[e];
      const ti = eTgt[e];
      const es = ends(si);
      if (!es.length) continue;
      const et = ends(ti);
      if (!et.length) continue;
      const sOut = !!selF && selF[si] === 1 && selF[ti] !== 1;
      const sIn = !!selF && selF[si] !== 1 && selF[ti] === 1;
      const hOut = !!hovF && hovF[si] === 1 && hovF[ti] !== 1;
      const hIn = !!hovF && hovF[si] !== 1 && hovF[ti] === 1;
      for (let x = 0; x < es.length; x++) {
        const a = es[x];
        const wa = wOf[a];
        for (let y = 0; y < et.length; y++) {
          const b = et[y];
          if (a === b) continue;
          const key = a * NN + b;
          let m = acc.get(key);
          if (!m) acc.set(key, (m = { ai: a, bi: b, w: 0, n: 0, ext: 0, out: false, inc: false, sel: false, hov: false, kinds: new Int32Array(K), samples: [] }));
          m.w += wa * wOf[b];
          m.n += 1;
          m.ext += eExt[e];
          if (sOut || hOut) m.out = true;
          if (sIn || hIn) m.inc = true;
          if (sOut || sIn) m.sel = true;
          if (hOut || hIn) m.hov = true;
          m.kinds[eKind[e]]++;
          if (m.samples.length < 3 && (a !== si || b !== ti)) m.samples.push(e);
        }
      }
    }
    type Pair = { a: string; b: string; w: number; n: number; ext: number; out: boolean; inc: boolean; sel: boolean; hov: boolean; best: string; src: Acc };
    const merged: Pair[] = [];
    for (const m of acc.values()) {
      let best = 0;
      for (let k = 1; k < K; k++) if (m.kinds[k] > m.kinds[best]) best = k;
      merged.push({ a: model.byIndex[m.ai].id, b: model.byIndex[m.bi].id, w: m.w, n: m.n, ext: m.ext, out: m.out, inc: m.inc, sel: m.sel, hov: m.hov, best: model.kindNames[best], src: m });
    }
    // only for lines actually drawn: the kind counts and a few examples, for the line's hover card
    const kindsOf = (m: Pair) => {
      const out = new Map<string, number>();
      m.src.kinds.forEach((c, k) => c && out.set(model.kindNames[k], c));
      return out;
    };
    const samplesOf = (m: Pair): [string, string][] => m.src.samples.map((e) => [model.byIndex[eSrc[e]].fullLabel, model.byIndex[eTgt[e]].fullLabel]);
    // at rest only the strongest folder/file links show; the others taper off and appear on focus
    const boxPairs = merged
      .filter((m) => !m.sel && !m.hov && states.get(m.a)!.n.box && states.get(m.b)!.n.box && m.ext < m.n)
      .sort((x, y) => y.w - x.w);
    const budget = new Map<string, number>();
    boxPairs.forEach((m, i) => budget.set(`${m.a}>${m.b}`, i < LINE_BUDGET ? 1 : i < LINE_BUDGET + 8 ? 1 - (i - LINE_BUDGET + 1) / 9 : 0));

    const obstacles = scaling ? null : buildObstacles(states);
    const curves: Curve[] = [];
    const outside = (p: Anchor) => Math.max(0, -p.cx, p.cx - s.w, -p.cy, p.cy - s.h);
    for (const m of merged) {
      const sa = states.get(m.a)!;
      const sb = states.get(m.b)!;
      const strength = m.w / m.n; // how much this pair is "the" current view of these relationships
      if (strength < 0.03) continue;
      const touched = m.sel || m.hov;
      const A = anchor(sa);
      const B = anchor(sb);
      const inA = A.cx > 0 && A.cx < s.w && A.cy > 0 && A.cy < s.h;
      const inB = B.cx > 0 && B.cx < s.w && B.cy > 0 && B.cy < s.h;
      if (!inA && !inB) continue;
      const kind = m.best as EdgeKind;
      const bothBoxes = sa.n.box && sb.n.box;
      const rare = RARE_KINDS.has(kind) && !bothBoxes;
      const external = m.ext === m.n;
      const local = sa.n.parent === sb.n.parent;
      let alpha = strength * (touched ? (m.sel ? 0.4 + 0.55 * s.emphSel : 0.75) : local ? 0.55 : bothBoxes ? 0.22 : 0.1);
      if (!touched) {
        if (focusAny && !(openSet && openSet.has(m.a) && openSet.has(m.b))) alpha *= 0.45;
        if (bothBoxes && !external) alpha *= budget.get(`${m.a}>${m.b}`) ?? 1;
        // fade at the screen edge instead of blinking out
        alpha *= (1 - smooth(0, 120, outside(A))) * (1 - smooth(0, 120, outside(B)));
      } else if (m.hov && !m.sel) alpha *= 0.5 + 0.5 * s.emphHov;
      let width = (1 + 3 * Math.min(1, Math.log2(m.w + 1) / Math.log2(41))) * (touched ? 1.6 : 1);
      let dash = rare && (alpha >= 0.15 || touched) ? (EDGE_STYLE[kind]?.dash ?? []) : [];
      let arrow = true;
      if (external && !touched) {
        // packages are context, not architecture: faint dotted threads
        dash = [1.5, 5];
        alpha *= 0.35;
        width = Math.min(width, 1.5);
        arrow = false;
      }
      if (!touched && local && !sb.n.box && sb.n.hubIn > 0) {
        // into a hub: quiet, no arrowhead (the hub's bubble says how many)
        alpha *= 0.35;
        width = 1;
        arrow = false;
      }
      if (alpha < 0.01) continue;
      // colour: one calm ink at rest; direction colours for the focused item (amber = it uses, periwinkle =
      // it is used by), blended in as the emphasis eases so nothing snaps
      let color = rare ? (EDGE_STYLE[kind]?.color ?? INK) : INK;
      if (touched && !rare) {
        const dir = m.out && m.inc ? FOCUS_BOTH : m.out ? FOCUS_OUT : FOCUS_IN;
        const amt = m.sel ? s.emphSel : s.emphHov;
        color = mixColor(INK_FOCUS, dir, Math.round(amt * 10) / 10);
      }
      // geometry: tiles are entered a little (the line plugs in), chips are met just outside their border
      const dx = B.cx - A.cx;
      const dy = B.cy - A.cy;
      const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      const inset = (st: NodeState) => (st.n.box ? -Math.min(28, 0.18 * Math.min(st.sw, st.sh)) : 2);
      const p = clip(A, dx / len, dy / len, inset(sa));
      const q = clip(B, -dx / len, -dy / len, inset(sb));
      const seg = Math.hypot(q.x - p.x, q.y - p.y);
      if (seg < 2) continue;
      const key = `${m.a}>${m.b}`;
      // gentle curve: the perpendicular flips with direction, so A→B and B→A bow apart into a lens. At rest a
      // line is routed around unrelated tiles (other side, then a wider bow) or left out; the choice is made
      // when the camera settles and kept while it moves, so lines never flip mid-zoom.
      let choice = s.curveChoice.get(key) ?? { sign: 1, mul: 1, skip: false };
      if (!touched && obstacles) {
        choice = route(p, q, seg, obstacles, sa, sb);
        if (s.curveChoice.size > 4000) s.curveChoice.clear();
        s.curveChoice.set(key, choice);
      }
      if (!touched && choice.skip) continue;
      const sign = touched ? 1 : choice.sign;
      const mul = touched ? 1 : choice.mul;
      const c = control(p, q, seg, sign, mul);
      curves.push({ key, a: sa, b: sb, p, c, q, color, alpha, width, dash, arrow, touched, sel: m.sel, inA, inB, n: m.n, kinds: kindsOf(m), samples: samplesOf(m), sign, mul });
    }
    void ctx;
    spreadPorts(curves);
    return curves;
  }

  /** Lines meeting one side of a node are spread over the middle 70% of that side (at least 6 px apart),
   *  ordered by where they go, so several lines into one tile or chip no longer pile onto one point. */
  function spreadPorts(curves: Curve[]) {
    type End = { c: Curve; at: "p" | "q"; st: NodeState; side: number; key: number };
    const groups = new Map<string, End[]>();
    for (const c of curves) {
      for (const at of ["p", "q"] as const) {
        const st = at === "p" ? c.a : c.b;
        const A = anchor(st);
        if (A.hw < 8 || A.hh < 6) continue;
        const pt = c[at];
        const other = at === "p" ? c.q : c.p;
        const rx = (pt.x - A.cx) / A.hw;
        const ry = (pt.y - A.cy) / A.hh;
        const side = Math.abs(rx) >= Math.abs(ry) ? (rx < 0 ? 0 : 1) : ry < 0 ? 2 : 3; // left, right, top, bottom
        const g = `${st.n.id}|${side}`;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push({ c, at, st, side, key: side < 2 ? other.y : other.x });
      }
    }
    const touched = new Set<Curve>();
    for (const ends of groups.values()) {
      if (ends.length < 2) continue;
      ends.sort((x, y) => x.key - y.key);
      const A = anchor(ends[0].st);
      const vertical = ends[0].side < 2;
      const half = (vertical ? A.hh : A.hw) * 0.7;
      const step = Math.max(6, (2 * half) / ends.length);
      const span = step * (ends.length - 1);
      const box = ends[0].st.n.box;
      const d = box ? Math.min(28, 0.18 * Math.min(ends[0].st.sw, ends[0].st.sh)) : -2; // inside a tile, outside a chip
      ends.forEach((e, i) => {
        const off = Math.max(-((vertical ? A.hh : A.hw) - 3), Math.min((vertical ? A.hh : A.hw) - 3, -span / 2 + i * step));
        const pt =
          e.side === 0
            ? { x: A.cx - A.hw + d, y: A.cy + off }
            : e.side === 1
              ? { x: A.cx + A.hw - d, y: A.cy + off }
              : e.side === 2
                ? { x: A.cx + off, y: A.cy - A.hh + d }
                : { x: A.cx + off, y: A.cy + A.hh - d };
        e.c[e.at] = pt;
        touched.add(e.c);
      });
    }
    for (const c of touched) {
      const seg = Math.hypot(c.q.x - c.p.x, c.q.y - c.p.y);
      if (seg > 1) c.c = control(c.p, c.q, seg, c.sign, c.mul);
    }
  }

  /** The line under the pointer (lines are thin: within 6 px of any of 16 points along it). */
  function pickEdge(px: number, py: number): Curve | null {
    let best: Curve | null = null;
    let bestD = 6;
    for (const c of S.current.curves) {
      if (c.alpha < 0.15 && !c.touched) continue;
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const x = (1 - t) * (1 - t) * c.p.x + 2 * (1 - t) * t * c.c.x + t * t * c.q.x;
        const y = (1 - t) * (1 - t) * c.p.y + 2 * (1 - t) * t * c.c.y + t * t * c.q.y;
        const dd = Math.hypot(px - x, py - y);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
    }
    return best;
  }

  /** Where the selection's lines leave the screen: a small tag naming what is at the other end. Click flies
   *  there. At most 6 (+ "N more"), merged when close, kept clear of the key. */
  function drawTags(ctx: CanvasRenderingContext2D) {
    const s = S.current;
    s.tags = [];
    if (!s.selected || s.emphSel < 0.5) return;
    const vr = visibleRect();
    const inset = 14;
    const inside = (pt: Pt) => pt.x > inset && pt.x < vr.w - inset && pt.y > inset && pt.y < vr.h - inset;
    const at = (c: Curve, t: number): Pt => ({
      x: (1 - t) * (1 - t) * c.p.x + 2 * (1 - t) * t * c.c.x + t * t * c.q.x,
      y: (1 - t) * (1 - t) * c.p.y + 2 * (1 - t) * t * c.c.y + t * t * c.q.y,
    });
    type Tag = { x: number; y: number; text: string; a: string; b: string; far: string; n: number };
    const tags: Tag[] = [];
    for (const c of s.curves) {
      if (!c.sel) continue;
      const pIn = inside(c.p), qIn = inside(c.q);
      if (pIn === qIn) continue;
      // bisection for the point where the line crosses the inset edge of the visible map
      let lo = pIn ? 0 : 1, hi = pIn ? 1 : 0;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (inside(at(c, mid))) lo = mid;
        else hi = mid;
      }
      const pt = at(c, lo);
      const far = pIn ? c.b : c.a;
      const arrow = pIn ? "→" : "←";
      tags.push({ x: pt.x, y: pt.y, text: `${arrow} ${far.n.label}${c.n > 1 ? ` · ${c.n}` : ""}`, a: c.a.n.id, b: c.b.n.id, far: far.n.id, n: c.n });
    }
    if (!tags.length) return;
    tags.sort((x, y) => y.n - x.n);
    const kept: Tag[] = [];
    let more = 0;
    for (const t of tags) {
      if (kept.some((k) => Math.hypot(k.x - t.x, k.y - t.y) < 22)) {
        more++;
        continue;
      }
      if (kept.length >= 6) {
        more++;
        continue;
      }
      kept.push(t);
    }
    const font = sans(600, 11);
    const draw = (x: number, y: number, text: string, hit?: Tag) => {
      const label = fitSmart(ctx, text, font, 200);
      const tw = measure(ctx, label, font);
      const w = tw + 14, h = 18;
      const bx = clamp(x - w / 2, 6, vr.w - w - 6);
      const by = clamp(y - h / 2, 6, vr.h - h - 6);
      ctx.globalAlpha = 0.95 * s.emphSel;
      roundRect(ctx, bx, by, w, h, 9);
      ctx.fillStyle = MAP_PANEL;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(FOCUS_OUT, 0.5);
      ctx.stroke();
      ctx.font = fontOf(font);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = MAP_INK;
      ctx.fillText(label, bx + 7, by + h / 2 + 0.5);
      if (hit) s.tags.push({ x: bx, y: by, w, h, a: hit.a, b: hit.b, far: hit.far });
    };
    for (const t of kept) draw(t.x, t.y, t.text, t);
    if (more > 0) {
      const last = kept[kept.length - 1];
      draw(last.x, last.y + 22, `+${more} more`);
    }
  }

  /** Fly so both ends of a relationship are in view, then ping the far end. */
  function flyToPair(a: string, b: string, ping: string) {
    const m = S.current.model;
    const na = m?.nodes.get(a), nb = m?.nodes.get(b);
    if (!na || !nb) return;
    const r = [na.rect, nb.rect];
    fly(
      transformFor(
        Math.min(...r.map((x) => x.x - x.w / 2)),
        Math.min(...r.map((x) => x.y - x.h / 2)),
        Math.max(...r.map((x) => x.x + x.w / 2)),
        Math.max(...r.map((x) => x.y + x.h / 2)),
      ),
      { pulse: { id: ping, count: 1 } },
    );
  }

  function control(p: Pt, q: Pt, seg: number, sign: number, mul: number): Pt {
    const ux = (q.x - p.x) / seg;
    const uy = (q.y - p.y) / seg;
    const bend = seg < 30 ? 0 : Math.min(40 * mul, seg * 0.15 * mul) * sign;
    return { x: (p.x + q.x) / 2 - uy * bend, y: (p.y + q.y) / 2 + ux * bend };
  }

  /** Closed tiles and chips on screen, bucketed in a 64 px grid, for routing lines around them. */
  function buildObstacles(states: Map<string, NodeState>): Obstacles {
    const cell = 64;
    const grid = new Map<string, Obstacle[]>();
    const add = (r: Obstacle) => {
      for (let gx = Math.floor(r.x / cell); gx <= Math.floor((r.x + r.w) / cell); gx++) {
        for (let gy = Math.floor(r.y / cell); gy <= Math.floor((r.y + r.h) / cell); gy++) {
          const k = `${gx},${gy}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push(r);
        }
      }
    };
    for (const st of states.values()) {
      if (!st.onScreen || st.da < 0.5) continue;
      if (st.n.box) {
        if (st.t < 0.5) add({ x: st.sx, y: st.sy, w: st.sw, h: st.sh, id: st.n.id, anc: st.n.ancestors });
      } else {
        const a = anchor(st);
        if (a.hw > 4) add({ x: a.cx - a.hw, y: a.cy - a.hh, w: a.hw * 2, h: a.hh * 2, id: st.n.id, anc: st.n.ancestors });
      }
    }
    return { cell, grid };
  }

  function route(p: Pt, q: Pt, seg: number, ob: Obstacles, sa: NodeState, sb: NodeState) {
    const own = new Set([sa.n.id, sb.n.id, ...sa.n.ancestors, ...sb.n.ancestors]);
    const blocked = (c: Pt) => {
      for (let i = 0; i < 8; i++) {
        const t = 0.1 + (0.8 * i) / 7;
        const x = (1 - t) * (1 - t) * p.x + 2 * (1 - t) * t * c.x + t * t * q.x;
        const y = (1 - t) * (1 - t) * p.y + 2 * (1 - t) * t * c.y + t * t * q.y;
        const bucket = ob.grid.get(`${Math.floor(x / ob.cell)},${Math.floor(y / ob.cell)}`);
        if (!bucket) continue;
        for (const r of bucket) {
          if (own.has(r.id) || r.anc.includes(sa.n.id) || r.anc.includes(sb.n.id)) continue;
          if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
        }
      }
      return false;
    };
    for (const [sign, mul] of [
      [1, 1],
      [-1, 1],
      [1, 2],
      [-1, 2],
    ]) {
      if (!blocked(control(p, q, seg, sign, mul))) return { sign, mul, skip: false };
    }
    return { sign: 1, mul: 1, skip: true };
  }

  function curvePath(ctx: CanvasRenderingContext2D, c: Curve) {
    ctx.beginPath();
    ctx.moveTo(c.p.x, c.p.y);
    ctx.quadraticCurveTo(c.c.x, c.c.y, c.q.x, c.q.y);
  }

  function strokeCurve(ctx: CanvasRenderingContext2D, c: Curve, onTop: boolean) {
    ctx.lineCap = "round";
    const dash = c.dash.map((d) => d * Math.max(1, c.width * 0.8));
    if (onTop) {
      // a dark casing keeps a focused line readable where it crosses tiles and other lines
      ctx.globalAlpha = 0.6 * Math.min(1, c.alpha * 1.5);
      ctx.strokeStyle = MAP_BG;
      ctx.lineWidth = c.width + 2;
      ctx.setLineDash(dash);
      curvePath(ctx, c);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (c.inA && c.inB) ctx.strokeStyle = withAlpha(c.color, c.alpha);
    else {
      // one end is off-screen: fade the line out towards it
      const g = ctx.createLinearGradient(c.p.x, c.p.y, c.q.x, c.q.y);
      g.addColorStop(c.inA ? 0 : 1, withAlpha(c.color, c.alpha));
      g.addColorStop(c.inA ? 1 : 0, withAlpha(c.color, 0));
      ctx.strokeStyle = g;
    }
    ctx.lineWidth = c.width;
    ctx.setLineDash(dash);
    if (onTop) {
      ctx.shadowColor = withAlpha(c.color, 0.5);
      ctx.shadowBlur = 6;
    }
    curvePath(ctx, c);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.setLineDash([]);
    // arrowheads: on top for focused lines; for resting lines into a chip here, into a tile in the socket pass
    if (c.arrow && c.inB && (onTop || !c.b.n.box)) drawArrow(ctx, c, onTop ? 8 : undefined);
  }

  function drawArrow(ctx: CanvasRenderingContext2D, c: Curve, size?: number) {
    const seg = Math.hypot(c.q.x - c.p.x, c.q.y - c.p.y);
    if (seg <= 32 || c.alpha <= 0.08) return;
    const ang = Math.atan2(c.q.y - c.c.y, c.q.x - c.c.x);
    const sz = size ?? Math.min(4 + c.width * 1.5, seg * 0.25);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(c.q.x, c.q.y);
    ctx.lineTo(c.q.x - sz * Math.cos(ang - 0.45), c.q.y - sz * Math.sin(ang - 0.45));
    ctx.lineTo(c.q.x - sz * Math.cos(ang + 0.45), c.q.y - sz * Math.sin(ang + 0.45));
    ctx.closePath();
    ctx.fillStyle = withAlpha(c.color, Math.min(1, c.alpha * 1.2));
    ctx.fill();
  }

  /** The part of a resting line inside its end tiles is drawn again over the tile, with a small source dot
   *  and the arrowhead, so a link visibly plugs into both tiles instead of ending in the gap between them. */
  function drawSockets(ctx: CanvasRenderingContext2D, c: Curve) {
    const ends = [c.a, c.b].filter((st) => st.n.box && st.t < 0.5);
    if (!ends.length) return;
    for (const st of ends) {
      ctx.save();
      roundRect(ctx, st.sx, st.sy, st.sw, st.sh, boxRadius(st.sw, st.sh));
      ctx.clip();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = withAlpha(c.color, Math.min(1, c.alpha * 1.15));
      ctx.lineWidth = c.width;
      ctx.lineCap = "round";
      ctx.setLineDash(c.dash.map((d) => d * Math.max(1, c.width * 0.8)));
      curvePath(ctx, c);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    if (c.a.n.box && c.a.t < 0.5 && c.inA && c.alpha > 0.08) {
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(c.p.x, c.p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(c.color, Math.min(1, c.alpha * 1.2));
      ctx.fill();
    }
    if (c.arrow && c.inB && c.b.n.box && c.b.t < 0.5) drawArrow(ctx, c);
  }

  /** The selection softly veils everything else (an open selected box stays unveiled); the selected item and
   *  the things it connects to are drawn again on top, at their normal look. */
  function drawVeil(ctx: CanvasRenderingContext2D, selSt: NodeState, states: Map<string, NodeState>) {
    const s = S.current;
    ctx.globalAlpha = VEIL * s.emphSel;
    ctx.fillStyle = MAP_BG;
    ctx.beginPath();
    ctx.rect(0, 0, s.w, s.h);
    const openSel = selSt.n.box && selSt.t >= 0.5;
    if (openSel) roundRectPath(ctx, selSt.sx, selSt.sy, selSt.sw, selSt.sh, boxRadius(selSt.sw, selSt.sh));
    ctx.fill("evenodd");
    const inside = subtree(selSt.n.id);
    const lit = new Map<string, number>();
    if (!openSel) lit.set(selSt.n.id, Infinity);
    for (const c of s.curves) {
      if (!c.sel) continue;
      const other = inside?.has(c.a.n.id) ? c.b : c.a;
      lit.set(other.n.id, Math.max(lit.get(other.n.id) ?? 0, c.width * c.alpha));
    }
    let pills = 0;
    for (const [id] of [...lit.entries()].sort((x, y) => y[1] - x[1])) {
      const st = states.get(id);
      if (!st || !st.onScreen) continue;
      if (st.n.box) drawBox(ctx, st);
      else {
        drawChip(ctx, st);
        // a far-away neighbour (a dot) gets its name, for the 12 strongest
        const g = chipGeom(ctx, st);
        if (g.ca < 0.5 && pills < 12) {
          pills++;
          queuePill(ctx, st.n.label, g.x + g.ch * 0.5, g.cy + 6, 1e9 - pills, st.da);
        }
      }
    }
    drawLabels();
  }

  /** One short glint along each of the selection's strongest lines when it is made, showing direction. */
  function drawGlint(ctx: CanvasRenderingContext2D, now: number): boolean {
    const s = S.current;
    if (!s.selected || s.reduced || document.visibilityState !== "visible") return false;
    const age = now - s.selAt;
    if (age > 700) return false;
    const lit = s.curves.filter((c) => c.sel);
    if (!lit.length || lit.length > 12) return true;
    const u = EASE_FLY(clamp((age - 100) / 600, 0, 1));
    if (u <= 0 || u >= 1) return true;
    for (const c of [...lit].sort((x, y) => y.width - x.width).slice(0, 6)) {
      const x = (1 - u) * (1 - u) * c.p.x + 2 * (1 - u) * u * c.c.x + u * u * c.q.x;
      const y = (1 - u) * (1 - u) * c.p.y + 2 * (1 - u) * u * c.c.y + u * u * c.q.y;
      ctx.globalAlpha = Math.sin(u * Math.PI) * 0.9;
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
    }
    return true;
  }

  /** Selection: a blue ring (the app accent) that grows in; hover: a quiet light ring. An open box gets a thin
   *  outline instead, so the room you are in does not glow. */
  function drawRing(ctx: CanvasRenderingContext2D, id: string, selectedRing: boolean, now: number) {
    const target = standIn(id);
    if (!target) return;
    const a = anchor(target);
    const open = target.n.box && target.t >= 0.5;
    const r = target.n.box ? boxRadius(target.sw, target.sh) : Math.min(a.hh, a.hw);
    const grow = selectedRing && !S.current.reduced ? smooth(0, 180, now - S.current.selAt) : 1;
    const pad = open ? 0 : 2 + 4 * (1 - grow);
    ctx.globalAlpha = (selectedRing ? 1 : 0.7) * Math.max(0.3, grow);
    if (selectedRing && !open) {
      ctx.shadowColor = withAlpha(ACCENT, 0.5);
      ctx.shadowBlur = 6;
    }
    ctx.lineWidth = open ? 1 : selectedRing ? 2 : 1.5;
    ctx.strokeStyle = selectedRing ? ACCENT : HOVER_RING;
    const box = target.n.box ? { x: target.sx, y: target.sy, w: target.sw, h: target.sh } : { x: a.cx - a.hw, y: a.cy - a.hh, w: a.hw * 2, h: a.hh * 2 };
    roundRect(ctx, box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2, r + pad);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  /** After a flight lands: a ring grows out of the target once (twice from search), so the eye finds it. */
  function drawPulse(ctx: CanvasRenderingContext2D, now: number): boolean {
    const s = S.current;
    if (!s.pulse) return false;
    const age = now - s.pulse.t0;
    if (age > 650 * s.pulse.count || s.reduced) {
      s.pulse = null;
      return false;
    }
    const target = standIn(s.pulse.id);
    if (!target) return true;
    const u = (age % 650) / 650;
    const a = anchor(target);
    const grow = 18 * EASE_FLY(u);
    ctx.globalAlpha = 0.65 * (1 - u);
    ctx.lineWidth = 2;
    ctx.strokeStyle = ACCENT;
    roundRect(ctx, a.cx - a.hw - grow, a.cy - a.hh - grow, (a.hw + grow) * 2, (a.hh + grow) * 2, 8 + grow);
    ctx.stroke();
    return true;
  }

  function updateCrumbs(model: MapModel, states: Map<string, NodeState>) {
    const s = S.current;
    const vr = visibleRect();
    const cx = vr.x + vr.w / 2;
    const cy = vr.y + vr.h / 2;
    let deepest: NodeState | undefined;
    for (const st of states.values()) {
      if (!st.n.box || st.t < 0.5 || st.vis < 0.5) continue;
      if (cx < st.sx || cx > st.sx + st.sw || cy < st.sy || cy > st.sy + st.sh) continue;
      if (!deepest || st.n.depth > deepest.n.depth) deepest = st;
    }
    const ids = deepest ? [...deepest.n.ancestors].reverse().concat(deepest.n.id) : [];
    const shown = ids.filter((id) => !(model.roots.length === 1 && id === model.roots[0]));
    const key = shown.join("|");
    if (key === s.crumbKey) return;
    s.crumbKey = key;
    s.crumbIds = shown;
    cb.current.onCrumbs?.(shown.map((id) => ({ id, label: model.nodes.get(id)!.label })));
  }

  // ---- picking -------------------------------------------------------------------------------------
  /** What is under the pointer: a closed tile, a symbol, or an open box's title band (clickable). */
  function pick(px: number, py: number): { st: NodeState; title: boolean } | null {
    const s = S.current;
    if (!s.model) return null;
    let hit: NodeState | null = null;
    let title = false;
    for (const st of s.states.values()) {
      if (st.vis < 0.5 || !st.onScreen) continue;
      if (st.n.box) {
        if (px < st.sx || px > st.sx + st.sw || py < st.sy || py > st.sy + st.sh) continue;
        if (st.t >= 0.5) {
          // open frames are see-through, except their title band
          const strip = stripPx(st.n);
          const titleA = st.da * smooth(0.05, 0.3, st.t);
          if (strip >= 12 && titleA > 0.5 && py <= st.sy + strip && (!hit || st.n.depth >= hit.n.depth)) {
            hit = st;
            title = true;
          }
          continue;
        }
        if (!hit || st.n.depth >= hit.n.depth) {
          hit = st;
          title = false;
        }
      } else {
        const a = anchor(st);
        if (Math.abs(px - a.cx) <= a.hw && Math.abs(py - a.cy) <= a.hh) {
          hit = st;
          title = false;
        }
      }
    }
    return hit ? { st: hit, title } : null;
  }

  /** Re-check what is under a resting pointer after the camera moved (zoom with the mouse held still). */
  function refreshHover() {
    const s = S.current;
    if (!s.ptr) return;
    const hit = pick(s.ptr.x, s.ptr.y);
    const id = hit?.st.n.id ?? null;
    if (id !== s.hover) {
      s.hover = id;
      s.hoverTitle = !!hit?.title;
      requestDraw();
    }
    if (s.tipShown) {
      s.tipShown = false;
      setTip(null); // no tooltips while the camera moves
    }
  }

  // ---- camera ----------------------------------------------------------------------------------------
  function transformFor(x1: number, y1: number, x2: number, y2: number, pad = 0.08): ZoomTransform {
    const vr = visibleRect();
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    // keep the content in the part of the map not covered by the key or the details panel
    const k = Math.min(vr.w / (w * (1 + 2 * pad)), vr.h / (h * (1 + 2 * pad)), MAX_ZOOM);
    return zoomIdentity.translate(vr.x + vr.w / 2 - ((x1 + x2) / 2) * k, vr.y + vr.h / 2 - ((y1 + y2) / 2) * k).scale(k);
  }

  function rectTransform(n: MapNode, pad = 0.08) {
    const r = n.rect;
    return transformFor(r.x - r.w / 2, r.y - r.h / 2, r.x + r.w / 2, r.y + r.h / 2, pad);
  }

  function fly(t: ZoomTransform, opts: { duration?: number; pulse?: { id: string; count: number } } = {}) {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.zoom) return;
    const sel = select(canvas);
    const v = s.view;
    const startPulse = () => {
      if (opts.pulse) s.pulse = { id: opts.pulse.id, t0: performance.now(), count: opts.pulse.count };
      requestDraw();
    };
    if (Math.abs(t.x - v.x) < 4 && Math.abs(t.y - v.y) < 4 && Math.abs(t.k / v.k - 1) < 0.02) {
      startPulse(); // already there: just show where
      return;
    }
    sel.interrupt();
    s.atHome = false;
    if (document.visibilityState !== "visible" || s.reduced) {
      s.zoom.transform(sel, t);
      startPulse();
      return;
    }
    // start from what is drawn (not d3's target, which may be ahead mid-glide), so a flight never jumps
    s.glide = false;
    s.flying = true;
    s.anchor = null;
    s.pulse = null;
    s.zoom.transform(sel, zoomIdentity.translate(v.x, v.y).scale(v.k));
    // short hops are quick, long trips unhurried: scale d3's own estimate of the zoom path length
    const p0: [number, number, number] = [(s.w / 2 - v.x) / v.k, (s.h / 2 - v.y) / v.k, s.w / v.k];
    const p1: [number, number, number] = [(s.w / 2 - t.x) / t.k, (s.h / 2 - t.y) / t.k, s.w / t.k];
    const duration = opts.duration ?? clamp(0.6 * interpolateZoom(p0, p1).duration, 400, 1100);
    const finish = (landed: boolean) => {
      s.glide = true;
      s.flying = false;
      s.lastScaleAt = performance.now();
      if (landed) {
        startPulse();
        saveCamera();
      }
      requestDraw();
    };
    sel
      .transition()
      .duration(duration)
      .ease(EASE_FLY)
      .call(s.zoom.transform, t)
      .on("end", () => finish(true))
      .on("interrupt", () => finish(false));
  }

  function homeTransform(): ZoomTransform | null {
    const m = S.current.model;
    if (!m) return null;
    const tops = m.roots.map((r) => m.nodes.get(r)!.rect);
    return transformFor(
      Math.min(...tops.map((r) => r.x - r.w / 2)),
      Math.min(...tops.map((r) => r.y - r.h / 2)),
      Math.max(...tops.map((r) => r.x + r.w / 2)),
      Math.max(...tops.map((r) => r.y + r.h / 2)),
      0.06,
    );
  }

  function zoomTo(id: string, opts: { pulse?: number } = {}) {
    const m = S.current.model;
    const n = m?.nodes.get(id);
    if (!m || !n) return;
    const target = n.box ? n : (m.nodes.get(n.parent ?? "") ?? n);
    fly(rectTransform(target), opts.pulse ? { pulse: { id, count: opts.pulse } } : {});
  }

  function fitAll() {
    const h = homeTransform();
    if (h) fly(h);
  }

  /** One level out: the parent of the box you are in, or the overview. */
  function upOneLevel() {
    const s = S.current;
    const up = s.crumbIds.length >= 2 ? s.crumbIds[s.crumbIds.length - 2] : null;
    if (up) zoomTo(up);
    else fitAll();
  }

  /** Fit the box you are in (the deepest open box at the centre). */
  function fitCurrent() {
    const s = S.current;
    const id = s.crumbIds[s.crumbIds.length - 1];
    if (id) zoomTo(id);
    else fitAll();
  }

  function zoomBy(f: number) {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.zoom) return;
    const vr = visibleRect();
    const c: Pt = { x: vr.w / 2, y: vr.h / 2 };
    s.zoom.scaleBy(select(canvas), f, [c.x, c.y]);
    s.anchor = c; // glide about the centre of the visible map
    s.atHome = false;
  }

  function panBy(dx: number, dy: number) {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.zoom) return;
    s.zoom.translateBy(select(canvas), dx / s.target.k, dy / s.target.k);
    s.atHome = false;
  }

  /** Bring a node into the part of the map not covered by the panel, by the smallest pan. */
  function ensureVisible(id: string) {
    const s = S.current;
    if (!s.homed || s.flying) return;
    const st = standIn(id);
    if (!st) return;
    const vr = visibleRect();
    const m = 48;
    const an = anchor(st);
    const a = { x1: an.cx - an.hw, y1: an.cy - an.hh, x2: an.cx + an.hw, y2: an.cy + an.hh };
    let dx = 0, dy = 0;
    if (a.x2 > vr.w - m) dx = vr.w - m - a.x2;
    if (a.x1 + dx < m) dx = m - a.x1;
    if (a.y2 > vr.h - m) dy = vr.h - m - a.y2;
    if (a.y1 + dy < m) dy = m - a.y1;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    const v = s.view;
    fly(zoomIdentity.translate(v.x + dx, v.y + dy).scale(v.k), { duration: 450 });
  }

  function zoomToPath(path: string) {
    const m = S.current.model;
    if (!m) return;
    const under = [...m.nodes.values()].filter((n) => n.path === path || n.path.startsWith(`${path}/`));
    const ids = new Set(under.map((n) => n.id));
    const tops = under.filter((n) => !n.parent || !ids.has(n.parent));
    if (!tops.length) return;
    if (tops.length === 1) return zoomTo(tops[0].id);
    fly(
      transformFor(
        Math.min(...tops.map((n) => n.rect.x - n.rect.w / 2)),
        Math.min(...tops.map((n) => n.rect.y - n.rect.h / 2)),
        Math.max(...tops.map((n) => n.rect.x + n.rect.w / 2)),
        Math.max(...tops.map((n) => n.rect.y + n.rect.h / 2)),
      ),
    );
  }

  /** Smart double-click: into a tile; a chip is selected and pinged; a title or empty space steps out. */
  function onDoubleClick(px: number, py: number) {
    const s = S.current;
    const hit = pick(px, py);
    if (hit && !hit.title && hit.st.n.box) return zoomTo(hit.st.n.id);
    if (hit && !hit.title) {
      const ctx = canvasRef.current!.getContext("2d")!;
      if (chipGeom(ctx, hit.st).ca < 0.5) return zoomTo(hit.st.n.id, { pulse: 1 });
      if (!isSynthetic(hit.st.n.id)) {
        s.selected = hit.st.n.id;
        s.selAt = performance.now();
        cb.current.onSelect(hit.st.n.id);
      }
      s.pulse = { id: hit.st.n.id, t0: performance.now(), count: 1 };
      requestDraw();
      return;
    }
    if (hit && hit.title) {
      const parent = hit.st.n.parent && s.model?.nodes.has(hit.st.n.parent) ? hit.st.n.parent : null;
      return parent ? zoomTo(parent) : fitAll();
    }
    // empty space: fit the open box around the point if it is not fitted yet, else step out of it
    let room: NodeState | undefined;
    for (const st of s.states.values()) {
      if (!st.n.box || st.t < 0.5 || st.vis < 0.5) continue;
      if (px < st.sx || px > st.sx + st.sw || py < st.sy || py > st.sy + st.sh) continue;
      if (!room || st.n.depth > room.n.depth) room = st;
    }
    if (!room) return fitAll();
    if (s.view.k < 0.9 * rectTransform(room.n).k) return zoomTo(room.n.id);
    const parent = room.n.parent && s.model?.nodes.has(room.n.parent) ? room.n.parent : null;
    return parent ? zoomTo(parent) : fitAll();
  }

  /** Size the canvas to its container. Measured directly (not only via ResizeObserver, which stays silent
   *  while a tab is hidden and for some first layouts). Keeps the centre in place when the window resizes.
   *  Returns whether there is room to draw. */
  function fitCanvas(): boolean {
    const s = S.current;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return false;
    const r = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width !== s.w || r.height !== s.h || dpr !== s.dpr) {
      const dx = s.homed && s.w > 2 && r.width > 2 ? (r.width - s.w) / 2 : 0;
      const dy = s.homed && s.h > 2 && r.height > 2 ? (r.height - s.h) / 2 : 0;
      s.dpr = dpr;
      s.w = r.width;
      s.h = r.height;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      // resizing clears an opaque canvas to black: paint the background at once
      const c2 = canvas.getContext("2d");
      if (c2) {
        c2.setTransform(1, 0, 0, 1, 0, 0);
        c2.fillStyle = MAP_BG;
        c2.fillRect(0, 0, canvas.width, canvas.height);
      }
      if ((dx || dy) && s.zoom) {
        s.view.x += dx;
        s.view.y += dy;
        s.zoom.transform(select(canvas), zoomIdentity.translate(s.target.x + dx, s.target.y + dy).scale(s.target.k));
      }
    }
    return s.w >= 2 && s.h >= 2;
  }

  /** Put the camera on the overview. Waits until the canvas has a real size: fitting into a 0×0 box would
   *  give zoom 0 and a map that never appears. */
  function goHome() {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!s.model || !canvas || !s.zoom || !fitCanvas()) return;
    const home = homeTransform();
    if (!home || !Number.isFinite(home.k) || home.k <= 0) return;
    s.homeK = home.k;
    s.zoom.scaleExtent([home.k * 0.5, MAX_ZOOM]);
    // the map cannot be flung away: the camera stays within the map's bounds plus a margin
    const tops = s.model.roots.map((r) => s.model!.nodes.get(r)!.rect);
    const x1 = Math.min(...tops.map((r) => r.x - r.w / 2)), x2 = Math.max(...tops.map((r) => r.x + r.w / 2));
    const y1 = Math.min(...tops.map((r) => r.y - r.h / 2)), y2 = Math.max(...tops.map((r) => r.y + r.h / 2));
    const mx = (x2 - x1) * 0.25, my = (y2 - y1) * 0.25;
    s.zoom.translateExtent([
      [x1 - mx, y1 - my],
      [x2 + mx, y2 + my],
    ]);
    // back on this tab: return to where you were (same map, nothing selected to fly to)
    let start = home;
    let restored = false;
    if (!s.selected && s.storageKey) {
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(s.storageKey) ?? "null") as { lk: string; k: number; x: number; y: number; w: number; h: number } | null;
        if (saved && saved.lk === s.layoutKey && saved.k >= home.k * 0.5 && saved.k <= MAX_ZOOM) {
          start = zoomIdentity.translate(saved.x + (s.w - saved.w) / 2, saved.y + (s.h - saved.h) / 2).scale(saved.k);
          restored = true;
        }
      } catch {
        /* storage unavailable: start at the overview */
      }
    }
    s.zoom.transform(select(canvas), start);
    s.view = { k: start.k, x: start.x, y: start.y };
    s.homed = true;
    s.atHome = !restored;
    api.current.requestDraw();
    if (s.selected && s.model.nodes.has(s.selected)) {
      const id = s.selected;
      setTimeout(() => api.current.zoomTo(id), 120);
    }
  }

  function saveCamera() {
    const s = S.current;
    if (!s.storageKey || !s.homed) return;
    try {
      const t = s.target;
      window.sessionStorage.setItem(s.storageKey, JSON.stringify({ lk: s.layoutKey, k: t.k, x: t.x, y: t.y, w: s.w, h: s.h }));
    } catch {
      /* storage unavailable */
    }
  }

  function preview(id: string | null) {
    const s = S.current;
    s.preview = id && s.model?.nodes.has(id) ? id : null;
    if (s.preview) s.pulse = { id: s.preview, t0: performance.now(), count: 1 };
    requestDraw();
  }

  const api = useRef({ zoomTo, upOneLevel, fitCurrent, fitAll, zoomBy, panBy, zoomToPath, homeTransform, fly, draw, pick, pickEdge, requestDraw, goHome, fitCanvas, ensureVisible, onDoubleClick, computeHealth, saveCamera, preview, flyToPair });
  useEffect(() => {
    api.current = { zoomTo, upOneLevel, fitCurrent, fitAll, zoomBy, panBy, zoomToPath, homeTransform, fly, draw, pick, pickEdge, requestDraw, goHome, fitCanvas, ensureVisible, onDoubleClick, computeHealth, saveCamera, preview, flyToPair };
  });

  // ---- set up canvas, input and resize once ------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const s = S.current;
    // an opaque canvas: the browser can skip blending it with the page (every frame paints the background)
    canvas.getContext("2d", { alpha: false });
    // draw in the same font as the rest of the app
    const appFont = getComputedStyle(document.body).fontFamily;
    if (appFont) SANS = appFont;

    const resize = () => {
      api.current.fitCanvas();
      if (!s.homed) api.current.goHome();
      api.current.requestDraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    window.addEventListener("resize", resize);
    resize();

    // accessibility: no glides or flights when the system asks for reduced motion
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => {
      s.reduced = mq.matches;
      canvas.style.transition = s.reduced ? "none" : "opacity 240ms ease";
    };
    onMotion();
    mq.addEventListener("change", onMotion);

    const z = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.01, MAX_ZOOM])
      // ×1.19 per wheel notch, native-speed touchpad pinch (ctrl+wheel); clamped so nothing jumps 4×
      .wheelDelta((e) => clamp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.0025) * (e.ctrlKey ? 8 : 1), -0.5, 0.5))
      .filter((e) => (!e.ctrlKey || e.type === "wheel") && !e.button && e.type !== "dblclick")
      .on("start", (e) => {
        const t = (e.sourceEvent as Event | null)?.type;
        if (t && s.menuOpen) {
          s.menuOpen = false;
          setMenu(null); // wheel or drag closes the menu
        }
        if (t === "mousedown" || t === "touchstart") {
          s.held = true;
          canvas.style.cursor = "grabbing";
        }
      })
      .on("zoom", (e) => {
        const src = e.sourceEvent as (Event & { type: string }) | null;
        if (src) {
          s.atHome = false;
          s.pulse = null; // the user took over: no landing ping
        }
        if (Math.abs(Math.log(e.transform.k) - Math.log(s.target.k)) > 1e-3) s.lastScaleAt = performance.now();
        s.target = e.transform;
        if (src?.type === "wheel") {
          const [px, py] = pointer(src, canvas);
          s.anchor = { x: px, y: py };
        }
        // dragging and pinching follow the fingers exactly; wheel zoom glides
        if (src && (src.type === "mousemove" || src.type === "pointermove" || src.type === "touchmove")) {
          s.view = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        }
        api.current.requestDraw();
      })
      .on("end", (e) => {
        s.held = false;
        canvas.style.cursor = s.hover ? "pointer" : "grab";
        if (e.sourceEvent) api.current.saveCamera();
        api.current.requestDraw();
      });
    s.zoom = z;
    const sel = select(canvas);
    sel.call(z).on("dblclick.zoom", null);

    const local = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // hover cards appear after a short rest on the same thing (no flicker while sweeping across the map)
    let tipTimer = 0;
    let tipFor = "";
    const hideTip = () => {
      window.clearTimeout(tipTimer);
      tipFor = "";
      if (s.tipShown) {
        s.tipShown = false;
        setTip(null);
      }
    };
    const onMove = (e: MouseEvent) => {
      const p = local(e);
      s.ptr = p;
      const tag = s.tags.find((t) => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h);
      const hit = tag ? null : api.current.pick(p.x, p.y);
      const edge = !hit && !tag && !s.held ? api.current.pickEdge(p.x, p.y) : null;
      const id = hit?.st.n.id ?? null;
      if (!s.held) canvas.style.cursor = hit || edge || tag ? "pointer" : "grab";
      if (id !== s.hover || !!hit?.title !== s.hoverTitle || (edge?.key ?? null) !== s.hoverEdge) {
        s.hover = id;
        s.hoverTitle = !!hit?.title;
        s.hoverEdge = edge?.key ?? null;
        api.current.requestDraw();
      }
      const what = hit && !hit.title ? `n:${hit.st.n.id}` : edge ? `e:${edge.key}` : "";
      if (what !== tipFor) {
        hideTip();
        tipFor = what;
        if (!what || s.held) return;
        tipTimer = window.setTimeout(() => {
          s.tipShown = true;
          if (hit) setTip({ x: p.x, y: p.y, node: hit.st.n });
          else if (edge) setTip({ x: p.x, y: p.y, edge });
        }, 250);
      }
    };
    const onLeave = () => {
      s.hover = null;
      s.hoverEdge = null;
      s.ptr = null;
      hideTip();
      api.current.requestDraw();
    };
    // d3-zoom swallows mousedown, so a drag is told apart from a click with pointer events
    let down: Pt | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      wrap.focus({ preventScroll: true });
      if (s.menuOpen && e.button === 0) {
        s.menuOpen = false;
        setMenu(null);
      }
      hideTip();
    };
    // A click selects at once (ring on the map), but tells the page only after a moment, so a double-click
    // can fly without first opening the details panel.
    let clickTimer = 0;
    const onClick = (e: MouseEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // that was a drag
      const p = local(e);
      // an edge tag: fly to both ends of that relationship
      const tag = s.tags.find((t) => p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h);
      if (tag) return api.current.flyToPair(tag.a, tag.b, tag.far);
      const hit = api.current.pick(p.x, p.y);
      if (!hit) {
        // a line: fly to both of its ends (the selection stays)
        const edge = api.current.pickEdge(p.x, p.y);
        if (edge) return api.current.flyToPair(edge.a.n.id, edge.b.n.id, edge.b.n.id);
      }
      const id = hit && !isSynthetic(hit.st.n.id) ? hit.st.n.id : null;
      if (id !== s.selected) s.selAt = performance.now();
      s.selected = id;
      api.current.requestDraw();
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => cb.current.onSelect(id), 220);
    };
    // right-click: a small menu of next steps for that node (Shift + right-click keeps the browser's menu)
    const onContext = (e: MouseEvent) => {
      if (e.shiftKey) return;
      e.preventDefault();
      const p = local(e);
      const hit = api.current.pick(p.x, p.y);
      if (!hit || isSynthetic(hit.st.n.id)) {
        s.menuOpen = false;
        setMenu(null);
        return;
      }
      window.clearTimeout(clickTimer);
      if (hit.st.n.id !== s.selected) s.selAt = performance.now();
      s.selected = hit.st.n.id;
      cb.current.onSelect(hit.st.n.id);
      hideTip();
      s.menuOpen = true;
      setMenu({ x: p.x, y: p.y, node: hit.st.n });
      api.current.requestDraw();
    };
    const onDbl = (e: MouseEvent) => {
      window.clearTimeout(clickTimer);
      s.selected = s.selProp; // the double-click flies; it does not change the selection
      const p = local(e);
      api.current.onDoubleClick(p.x, p.y);
    };
    // keyboard: the map is focusable; keys are ignored while typing in a field
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
      const step = (d: number) => (e.shiftKey ? d * 0.4 : 120);
      let handled = true;
      switch (e.key) {
        case "Backspace":
          api.current.upOneLevel();
          break;
        case "Escape":
          if (s.menuOpen) {
            s.menuOpen = false;
            setMenu(null);
            break;
          }
          window.clearTimeout(clickTimer);
          s.selected = null;
          cb.current.onSelect(null);
          api.current.requestDraw();
          break;
        case "Enter": {
          const id = s.hover ?? s.selected;
          if (id) api.current.zoomTo(id, { pulse: 1 });
          break;
        }
        case "0":
        case "Home":
          api.current.fitAll();
          break;
        case "+":
        case "=":
          api.current.zoomBy(1.5);
          break;
        case "-":
        case "_":
          api.current.zoomBy(1 / 1.5);
          break;
        case "ArrowLeft":
          api.current.panBy(step(s.w), 0);
          break;
        case "ArrowRight":
          api.current.panBy(-step(s.w), 0);
          break;
        case "ArrowUp":
          api.current.panBy(0, step(s.h));
          break;
        case "ArrowDown":
          api.current.panBy(0, -step(s.h));
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    };
    // self-healing: redraw after a GPU reset or when the tab becomes visible again
    const onRestored = () => api.current.requestDraw();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      api.current.fitCanvas();
      if (!s.homed) api.current.goHome();
      api.current.requestDraw();
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("contextmenu", onContext);
    canvas.addEventListener("contextrestored", onRestored);
    wrap.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onVisible);

    // debugging/verification hook (no UI effect)
    (canvas as unknown as { __archon: unknown }).__archon = {
      state: s,
      draw: () => api.current.draw(),
      pick: (x: number, y: number) => api.current.pick(x, y)?.st.n ?? null,
      zoomTo: (id: string) => api.current.zoomTo(id),
    };

    // ?debug=map: frame times and settle state in a corner
    let dbgTimer = 0;
    if (new URLSearchParams(window.location.search).get("debug") === "map") {
      dbgTimer = window.setInterval(() => {
        const ms = [...s.frameMs].sort((a, b) => a - b);
        const q = (f: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * f))] : 0);
        setDebug({ p50: q(0.5), p95: q(0.95), boxes: s.dbg.boxes, half: s.dbg.half, settled: s.dbg.settled, k: s.view.k });
      }, 500);
    }

    cb.current.onReady?.({
      zoomTo: (id, opts) => api.current.zoomTo(id, opts),
      zoomToPath: (path) => api.current.zoomToPath(path),
      reset: () => api.current.fitAll(),
      upOneLevel: () => api.current.upOneLevel(),
      zoomBy: (f) => api.current.zoomBy(f),
      fitCurrent: () => api.current.fitCurrent(),
      preview: (id) => api.current.preview(id),
    });

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
      mq.removeEventListener("change", onMotion);
      sel.on(".zoom", null);
      sel.interrupt();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("contextmenu", onContext);
      window.clearTimeout(tipTimer);
      canvas.removeEventListener("contextrestored", onRestored);
      wrap.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(clickTimer);
      window.clearInterval(dbgTimer);
      // cancel the pending frame AND forget it: a stale id would make requestDraw() think a frame is still
      // queued and never draw again (React remounts effects in development, so this path runs on every load)
      if (s.frame) {
        if (s.frameByTimer) clearTimeout(s.frame);
        else cancelAnimationFrame(s.frame);
        s.frame = 0;
      }
    };
  }, []);

  // ---- (re)build the model when the graph changes ---------------------------------------------------------
  useEffect(() => {
    const s = S.current;
    const seq = ++s.seq;
    const view = buildView(graph);
    const key = viewKey(view);
    const apply = (pos: Parameters<typeof buildMapModel>[1]) => {
      if (seq !== s.seq) return;
      const model = buildMapModel(view, pos);
      s.model = model;
      s.layoutKey = key;
      s.anim.clear();
      s.subtrees.clear();
      s.curveChoice.clear();
      s.classBorder.clear();
      api.current.computeHealth();
      s.drawError = "";
      setLayout({ state: "idle" });
      emitKey(model);
      s.homed = false;
      // place the camera now, or as soon as the container has a size (checked directly, a few times a second)
      let tries = 0;
      const place = () => {
        if (seq !== s.seq || s.homed) return;
        api.current.goHome();
        if (s.homed) {
          if (tries >= 20) setLayout({ state: "idle" });
          api.current.requestDraw();
          return;
        }
        if (++tries === 20) setLayout({ state: "waiting" });
        setTimeout(place, 250);
      };
      place();
    };
    const cached = cachedLayout(key);
    if (cached) {
      apply(cached);
      return;
    }
    setLayout({ state: "running", items: view.nodes.length });
    computeLayout(view, key).then(apply, (err: Error) => {
      if (seq !== s.seq || err.message === "superseded") return;
      setLayout({ state: "error", message: `layout failed: ${err.message}` });
    });
  }, [graph]);

  function emitKey(model: MapModel) {
    const areas = model.roots
      .map((id) => model.nodes.get(id)!)
      .filter((n) => n.box && !n.neutral)
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((n) => ({ id: n.id, label: n.label, top: n.pal.tileTop, bottom: n.pal.tileBottom, border: n.pal.tileBorder }));
    const symbols = new Set<NodeKind>();
    for (const n of model.nodes.values()) if (!n.box && n.kind !== "file" && n.kind !== "directory") symbols.add(n.kind as NodeKind);
    const lines = new Set<EdgeKind>();
    let external = false;
    for (const e of model.edges) {
      if (e.external) external = true;
      else lines.add(e.kind as EdgeKind);
    }
    cb.current.onKey?.({ areas, symbols: [...symbols], lines: [...lines], external });
  }

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      aria-label="Code map. Scroll to zoom, drag to pan, Backspace to go up a level, 0 to fit all."
      className="absolute inset-0 overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      style={{ background: MAP_BG }}
    >
      <canvas ref={canvasRef} className="block touch-none select-none" style={{ cursor: "grab", opacity: 0 }} />
      {tip && (
        <div
          className="pointer-events-none absolute z-20 rounded-md border border-line px-2.5 py-1.5 text-[11px] shadow-xl space-y-0.5"
          style={{
            left: Math.max(6, Math.min(tip.x + 14, (S.current.w || 400) - 316)),
            top: tip.y + 16 + 140 > (S.current.h || 600) ? Math.max(6, tip.y - 140) : tip.y + 16,
            maxWidth: 310,
            background: `${MAP_PANEL}f2`,
          }}
        >
          {tip.node && <TipRows node={tip.node} health={S.current.health.get(tip.node.id)} />}
          {tip.edge && <EdgeRows edge={tip.edge} />}
        </div>
      )}
      {menu && (
        <NodeMenu
          menu={menu}
          maxX={(S.current.w || 400) - 220}
          maxY={(S.current.h || 400) - 300}
          onPick={(kind) => {
            S.current.menuOpen = false;
            setMenu(null);
            if (kind === "zoom") api.current.zoomTo(menu.node.id, { pulse: 1 });
            else if (kind === "inspect") cb.current.onSelect(menu.node.id);
            else cb.current.onAction?.(kind, menu.node.id);
          }}
        />
      )}
      {focusHint && (
        <div className="absolute top-3 left-3 z-10 chip pointer-events-none" style={{ background: "#151922e6" }}>
          <span className="h-0.5 w-3 rounded" style={{ background: FOCUS_OUT }} /> uses
          <span className="h-0.5 w-3 rounded ml-2" style={{ background: FOCUS_IN }} /> used by
        </div>
      )}
      {layout.state === "running" && (
        <div className="absolute top-3 right-3 z-10 chip pointer-events-none">
          <span className="h-1.5 w-1.5 rounded-full bg-accent pulse" /> arranging {layout.items} items…
        </div>
      )}
      {layout.state === "waiting" && <div className="absolute top-3 right-3 z-10 chip pointer-events-none">waiting for the map area…</div>}
      {layout.state === "error" && (
        <div className="absolute top-3 right-3 z-10 chip text-danger border-danger/40">{layout.message}</div>
      )}
      {debug && (
        <div className="absolute bottom-16 right-3 z-20 chip mono pointer-events-none text-[10px]">
          frame p50 {debug.p50.toFixed(1)} ms · p95 {debug.p95.toFixed(1)} ms · boxes {debug.boxes} · half-open {debug.half} ·{" "}
          {debug.settled ? "settled" : "moving"} · k {debug.k.toFixed(3)}
        </div>
      )}
    </div>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Hover card for a node: at most six short rows of facts. */
function TipRows({ node, health }: { node: MapNode; health?: Health }) {
  const rows: React.ReactNode[] = [];
  const kind = KIND_STYLE[node.kind as NodeKind]?.label ?? (node.kind === "group" ? "Packages" : node.kind === "files" ? "Files" : node.kind);
  rows.push(
    <div key="t" className="flex items-baseline gap-2">
      <span className="mono text-fg break-all">{node.fullLabel}</span>
      <span className="text-faint shrink-0">{kind}</span>
    </div>,
  );
  if (node.detail) rows.push(<div key="d" className="mono text-muted break-all">{node.detail}</div>);
  if (node.path) rows.push(<div key="p" className="text-faint truncate">{node.path}</div>);
  const size = [...node.summary, node.lines > 0 ? `${node.lines} lines` : ""].filter(Boolean).join(" · ");
  if (size) rows.push(<div key="s" className="text-muted">{size}</div>);
  if (node.kind === "file" && (node.fanIn || node.fanOut)) {
    rows.push(
      <div key="f" className="text-muted">
        imported by {plural(node.fanIn, "file")} · imports {node.fanOut}
        {node.testedBy > 0 ? " · a test imports it" : ""}
      </div>,
    );
  } else if (!node.box && (node.fanIn || node.fanOut)) {
    rows.push(<div key="f" className="text-muted">used by {node.fanIn} · uses {node.fanOut}</div>);
  }
  if (health && health.count > 0) {
    rows.push(
      <div key="h" className="flex items-center gap-1.5 text-muted">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: softSeverity(health.worst) }} />
        {plural(health.count, "finding")} · worst {health.worst}
      </div>,
    );
  }
  return <>{rows.slice(0, 6)}</>;
}

/** Hover card for a line: what it connects and what it is made of. */
function EdgeRows({ edge }: { edge: Curve }) {
  const kinds = [...edge.kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${EDGE_STYLE[k as EdgeKind]?.label ?? k}`);
  return (
    <>
      <div className="mono text-fg break-all">
        {edge.a.n.label} → {edge.b.n.label}
      </div>
      <div className="text-muted">
        {plural(edge.n, "relationship")}
        {kinds.length > 1 || edge.n > 1 ? ` · ${kinds.join(" · ")}` : ""}
      </div>
      {edge.samples[0] && (
        <div className="mono text-faint break-all">
          e.g. {edge.samples[0][0]} → {edge.samples[0][1]}
        </div>
      )}
      <div className="text-faint">click to see both ends</div>
    </>
  );
}

/** Right-click menu: next steps for a node. */
function NodeMenu({
  menu,
  maxX,
  maxY,
  onPick,
}: {
  menu: { x: number; y: number; node: MapNode };
  maxX: number;
  maxY: number;
  onPick: (kind: NodeAction | "zoom" | "inspect") => void;
}) {
  const n = menu.node;
  const callable = n.kind === "function" || n.kind === "method";
  const items: [NodeAction | "zoom" | "inspect", string][] = [
    ["inspect", "Inspect"],
    ["zoom", "Zoom to"],
    ["impact", "Change impact"],
    ...(callable ? ([["tests", "Generate tests"]] as [NodeAction, string][]) : []),
    ["refactor", "Refactoring ideas"],
    ["chat", "Ask Chat about it"],
    ["copy", "Copy path"],
    ["open", "Open in editor"],
  ];
  return (
    <div
      role="menu"
      className="absolute z-30 w-52 rounded-lg border border-line py-1 text-xs shadow-2xl animate-[menuIn_120ms_ease-out]"
      style={{ left: Math.max(6, Math.min(menu.x + 4, maxX)), top: Math.max(6, Math.min(menu.y + 4, maxY)), background: MAP_PANEL }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 py-1.5 mono text-faint truncate border-b border-line mb-1">{n.fullLabel}</div>
      {items.map(([k, label]) => (
        <button key={k} role="menuitem" className="w-full text-left px-3 py-1.5 text-muted hover:text-fg hover:bg-[#1c212c]" onClick={() => onPick(k)}>
          {label}
        </button>
      ))}
    </div>
  );
}
