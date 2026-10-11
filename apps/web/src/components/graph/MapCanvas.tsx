"use client";

/**
 * Smooth semantic-zoom code map, rendered on a 2D canvas (decisions.md D-026, D-027).
 *
 * - Camera: d3-zoom for input (wheel, pinch, drag) and fly-to transitions. The drawn view eases toward
 *   d3's target with a time-based glide, zooming about the cursor, so it feels the same at any refresh rate.
 * - Detail: each box has an openness from its size on screen. While you zoom it follows the size
 *   continuously; once you stop it settles to fully open or fully closed (with hysteresis), so nothing
 *   rests half-open. Opening is one card: the tile body fades away over its frame while the name moves
 *   into the header and the children (with their names) fade in.
 * - Relationships: each code-level edge is spread over the nodes that currently stand in for its ends, so
 *   lines cross-fade from folder↔folder to function↔function. Lines in a calm neutral ink; colour and dash
 *   patterns only for the rarer kinds (extends, implements, exposes, queries); package lines are faint
 *   dotted threads. Lines of the hovered/selected item are drawn on top.
 * - Labels: drawn after everything else, kept inside the visible part of their box; small tiles get a name
 *   pill below them unless it would collide with another label (the tooltip then shows it).
 */
import { useEffect, useRef, useState } from "react";
import { pointer, select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { interpolateZoom } from "d3-interpolate";
import "d3-transition";
import { EDGE_STYLE, KIND_STYLE, type EdgeKind, type Graph, type NodeKind } from "@/lib/api";
import { cachedLayout, computeLayout, viewKey } from "./layoutClient";
import { BG, buildMapModel, NEUTRAL_HUE, tint, withAlpha, type MapModel, type MapNode } from "./mapModel";
import { fitParts, fitSmart, measure } from "./mapText";
import { buildView, CHIP_H, isSynthetic } from "./viewModel";

export interface Crumb {
  id: string;
  label: string;
}

export interface MapController {
  zoomTo: (id: string) => void;
  zoomToPath: (path: string) => void;
  reset: () => void;
}

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
const MAX_ZOOM = 6;
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
const TEXT = "#e6e9f0";
const MUTED = "#a4adbe";
const INK = "#a9b3c4"; // relationships at rest: one calm neutral
const INK_FOCUS = "#d6deeb"; // relationships of the hovered / selected item
const ACCENT = "#5aa9ff"; // selection (the app accent)
const HOVER_RING = "#c9d3e3";
const RARE_KINDS = new Set<string>(["extends", "implements", "exposes", "queries"]);
const NEUTRAL_TOP = "#3b3a36";
const NEUTRAL_BOTTOM = "#302f2c";
const NEUTRAL_BORDER = "#6f6d66";

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const boxRadius = (sw: number, sh: number) => Math.min(14, Math.max(4, Math.min(sw, sh) * 0.06));

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

export function MapCanvas({ graph, selected, onSelect, onCrumbs, onReady, onKey, insetBottom = 0 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<LayoutState>({ state: "idle" });
  const [tip, setTip] = useState<{ x: number; y: number; node: MapNode } | null>(null);
  const [debug, setDebug] = useState<Debug | null>(null);

  // Everything the frame loop needs lives in one mutable ref (no React re-render per frame).
  const S = useRef({
    model: null as MapModel | null,
    target: zoomIdentity as ZoomTransform,
    view: { k: 1, x: 0, y: 0 } as View,
    glide: true,
    anchor: null as { x: number; y: number } | null, // zoom focus point (the cursor for wheel zoom)
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
    hover: null as string | null,
    selected: null as string | null,
    selProp: null as string | null,
    subtrees: new Map<string, Set<string>>(),
    ptr: null as { x: number; y: number } | null,
    tipShown: false,
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
    atHome: false, // camera still on the overview it was placed at (no user move yet)
  });
  const cb = useRef({ onSelect, onCrumbs, onReady, onKey });
  useEffect(() => {
    cb.current = { onSelect, onCrumbs, onReady, onKey };
  });

  useEffect(() => {
    S.current.insetBottom = insetBottom;
    // the key reports its height after the first placement: re-place an untouched overview so it fits above
    if (S.current.atHome) api.current.goHome();
  }, [insetBottom]);

  useEffect(() => {
    S.current.selected = selected;
    S.current.selProp = selected;
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    return { sx: (r.x - r.w / 2) * v.k + v.x, sy: (r.y - r.h / 2) * v.k + v.y, sw: r.w * v.k, sh: r.h * v.k };
  }

  /** How open a box should be for its current size on screen (continuous). */
  function openness(n: MapNode, sw: number, sh: number, forced: boolean): number {
    if (!n.box) return 0;
    if (forced) return 1;
    const s = S.current;
    const area = (sw * sh) / Math.max(1, s.w * s.h);
    const span = Math.max(sw / Math.max(1, s.w), sh / Math.max(1, s.h));
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

    // -- camera: ease the drawn view toward d3's target, zooming about the anchor (the cursor for wheel
    //    zoom), in log space so every notch feels the same; time-based so 60 Hz and 144 Hz feel alike
    const tv = s.target;
    const v = s.view;
    const a = s.glide && visible && !s.reduced ? 1 - Math.exp(-dt / GLIDE_MS) : 1;
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

    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, s.w, s.h);
    drawGrid(ctx, v);

    // -- pass 0: openness (continuous while zooming, settled at rest) and visibility
    const states = new Map<string, NodeState>();
    const margin = 80;
    let pending = false; // a box is still settling
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
        if (isNew || !visible || s.reduced) an.shown = goal;
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

    const boxes = [...states.values()].filter((st) => st.n.box && st.onScreen).sort((x, y) => x.n.depth - y.n.depth);
    const leaves = [...states.values()].filter((st) => !st.n.box && st.onScreen && st.da > 0.01);

    // -- pass 1: open surfaces (each box's frame fill, under everything inside it)
    for (const st of boxes) if (st.t > 0.005 && st.da > 0.01) drawFrameFill(ctx, st);
    // -- pass 2: relationships (the focused ones are kept for later, on top)
    const onTop = drawEdges(ctx, model, states);
    // -- pass 3: box bodies + borders, then symbol chips
    for (const st of boxes) if (st.da > 0.01) drawBox(ctx, st);
    for (const st of leaves) drawChip(ctx, st);
    // -- pass 4: focused relationships, continuous and above tiles
    for (const f of onTop) f();
    // -- pass 5: labels (titles, names, pills) above everything
    drawLabels();
    // -- pass 6: selection and hover rings
    if (s.selected) drawRing(ctx, states, s.selected, true);
    if (s.hover && s.hover !== s.selected) drawRing(ctx, states, s.hover, false);

    updateCrumbs(model, states);
    if (moved) refreshHover();
    if (!s.revealed) {
      s.revealed = true;
      canvas.style.opacity = "1";
    }
    s.dbg = { boxes: boxes.length, half, settled: camSettled && !pending && !scaling };
    if (!camSettled || pending || scaling) requestDraw();
  }

  function drawGrid(ctx: CanvasRenderingContext2D, v: View) {
    // dots every 2^n world units, chosen so they sit 22–44 px apart; the finer level fades in smoothly
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
      for (let x = x0; x < S.current.w; x += px) for (let y = y0; y < S.current.h; y += px) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
  }

  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
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

  function frameFill(n: MapNode): string {
    if (n.neutral) return tint(NEUTRAL_HUE, 0.06);
    return tint(n.hue, Math.min(0.05 + n.depth * 0.022, 0.13));
  }

  /** The open surface. Drawn fully (not faded by openness): the tile body then fades away over it, so a
   *  box opening is one card changing, never a see-through double image. */
  function drawFrameFill(ctx: CanvasRenderingContext2D, st: NodeState) {
    ctx.globalAlpha = st.da;
    roundRect(ctx, st.sx, st.sy, st.sw, st.sh, boxRadius(st.sw, st.sh));
    ctx.fillStyle = frameFill(st.n);
    ctx.fill();
  }

  /** Tile body (fading as the box opens), one border, and the box's labels. */
  function drawBox(ctx: CanvasRenderingContext2D, st: NodeState) {
    const s = S.current;
    const { n, sx, sy, sw, sh } = st;
    if (sw < 2 || sh < 2) return;
    const radius = boxRadius(sw, sh);
    const e = smooth(0.15, 0.7, st.t);
    const bodyA = st.da * (1 - e);
    if (bodyA > 0.01) {
      ctx.globalAlpha = bodyA;
      if (sw > 36) {
        // soft shadow lifts tiles off the background
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = Math.min(22, sw * 0.08);
        ctx.shadowOffsetY = Math.min(6, sw * 0.02);
      }
      const g = ctx.createLinearGradient(0, sy, 0, sy + sh);
      g.addColorStop(0, n.neutral ? NEUTRAL_TOP : tint(n.hue, 0.34));
      g.addColorStop(1, n.neutral ? NEUTRAL_BOTTOM : tint(n.hue, 0.22));
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
    // one border, morphing from the tile's to the frame's; a box bigger than the screen is the room you are
    // in, and its edges fade so they do not stack up as rails along the screen
    const room = 1 - smooth(1.1, 1.8, Math.max(sw / s.w, sh / s.h));
    if (room > 0.01) {
      ctx.globalAlpha = st.da * room;
      roundRect(ctx, sx, sy, sw, sh, radius);
      ctx.lineWidth = 1;
      if (n.neutral) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = withAlpha(NEUTRAL_BORDER, 0.9 - 0.45 * e);
      } else {
        ctx.strokeStyle = withAlpha(n.hue, 0.7 - 0.38 * e);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (st.t < 0.3) queueTileName(ctx, st);
    if (st.t > 0.05) queueFrameTitle(ctx, st);
  }

  /** The closed tile's name (and summary), centred on the part of the tile you can see. Size follows the
   *  tile, not the name, so equal tiles carry equal names; long names shrink a little, then shorten. */
  function queueTileName(ctx: CanvasRenderingContext2D, st: NodeState) {
    const s = S.current;
    const { n, sx, sy, sw, sh } = st;
    const alpha = st.da * (1 - smooth(0, 0.3, st.t));
    if (alpha < 0.02) return;
    const vx1 = Math.max(sx, 8), vy1 = Math.max(sy, 8);
    const vx2 = Math.min(sx + sw, s.w - 8), vy2 = Math.min(sy + sh, s.h - 8);
    const vw = vx2 - vx1, vh = vy2 - vy1;
    let size = Math.min(22, sw / 7, sh / 3.2);
    // mid-sized tiles keep their name inside at a small but legible size; only tiny tiles use a pill
    if (size < 11 && sw >= 48 && sh >= 22) size = 10.5;
    if (size >= 10.5 && vw >= 44 && vh >= size * 1.6) {
      const want = measure(ctx, n.label, `600 ${size}px ${SANS}`);
      if (want > vw - 16) size = Math.max(Math.min(size, 11), size * 0.8, Math.min(size, (size * (vw - 16)) / want));
      const font = `600 ${size}px ${SANS}`;
      const name = fitSmart(ctx, n.label, font, vw - 16);
      if (!name) return;
      if (name !== n.label) st.nameHidden = true;
      const subSize = Math.max(11, size * 0.62);
      const subFont = `${subSize}px ${SANS}`;
      const sub = sh > size * 3.4 && vh > size * 3 ? fitParts(ctx, n.summary, subFont, vw - 16) : "";
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
          ctx.font = font;
          ctx.fillStyle = TEXT;
          ctx.fillText(name, cx, cy);
          if (sub) {
            ctx.font = subFont;
            ctx.fillStyle = withAlpha("#dfe5ee", 0.78);
            ctx.fillText(sub, cx, cy + size * 1.15);
          }
        },
      });
    } else if (sw > 6 && alpha > 0.3) {
      st.nameHidden = true; // the pill may lose a collision; the tooltip always has the name
      const font = `600 11px ${SANS}`;
      const text = fitSmart(ctx, n.label, font, 160);
      if (!text) return;
      const tw = measure(ctx, text, font);
      const cx = sx + sw / 2;
      const py = sy + sh + 3;
      S.current.labels.push({
        x: cx - tw / 2 - 5,
        y: py,
        w: tw + 10,
        h: 16,
        pill: true,
        area: sw * sh,
        draw: () => {
          ctx.globalAlpha = alpha * 0.95;
          roundRect(ctx, cx - tw / 2 - 5, py, tw + 10, 16, 6);
          ctx.fillStyle = "rgba(15,18,24,0.88)";
          ctx.fill();
          ctx.font = font;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = TEXT;
          ctx.fillText(text, cx, py + 8.5);
        },
      });
    }
  }

  /** An open box's title band: name on the left, contents on the right, kept inside the visible part. */
  function queueFrameTitle(ctx: CanvasRenderingContext2D, st: NodeState) {
    const s = S.current;
    const { n, sx, sy, sw } = st;
    const alpha = st.da * smooth(0.05, 0.3, st.t);
    if (alpha < 0.02) return;
    const band = (n.rect.header ?? 20) * s.view.k;
    if (band < 12) return;
    const size = clamp(band * 0.4, 12, 20);
    const ty = sy + Math.max(band, size * 1.6) / 2;
    if (ty < -size || ty > s.h + size) return;
    const visL = Math.max(sx, 0) + 12;
    const visR = Math.min(sx + sw, s.w) - 12;
    if (visR - visL < 40) return;
    const font = `600 ${size}px ${SANS}`;
    const title = fitSmart(ctx, n.label, font, 0.6 * (visR - visL));
    if (!title) return;
    const titleW = measure(ctx, title, font);
    const tx = Math.max(sx + 12, Math.min(visL, visR - titleW));
    const subFont = `${Math.max(11, size - 3)}px ${SANS}`;
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
        ctx.font = font;
        ctx.fillStyle = n.neutral ? "#d8d3c4" : n.hue;
        ctx.fillText(title, tx, ty);
        if (sub) {
          ctx.font = subFont;
          ctx.fillStyle = MUTED;
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

  /** Chip geometry for a symbol (screen space). Below ~19 px tall it is drawn as a dot at the chip's dot. */
  function chipGeom(st: NodeState) {
    const v = S.current.view;
    const ch = CHIP_H * v.k;
    const cw = Math.max(18, st.n.rect.w - 8) * v.k;
    const cx = st.n.rect.x * v.k + v.x;
    const cy = st.n.rect.y * v.k + v.y;
    return { ch, cw, cx, cy, x: cx - cw / 2, y: cy - ch / 2, ca: smooth(19, 23, ch) };
  }

  function drawChip(ctx: CanvasRenderingContext2D, st: NodeState) {
    const s = S.current;
    const { n } = st;
    const { ch, cw, cy, x, y, ca } = chipGeom(st);
    if (x > s.w || y > s.h || x + cw < 0 || y + ch < 0) return;
    const color = KIND_STYLE[n.kind as NodeKind]?.color ?? n.hue;
    const base = st.da * (n.quiet ? 0.5 : 1);
    if (ca < 1) {
      // far away: a small coloured dot exactly where the chip's own dot will be, growing into the chip
      ctx.globalAlpha = base * (1 - ca) * 0.85;
      ctx.beginPath();
      ctx.arc(x + ch * 0.5, cy, Math.max(1.5, ch * 0.17), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (ca <= 0) return;
    // one alpha for capsule, dot and name: a capsule is never blank
    ctx.globalAlpha = base * ca;
    roundRect(ctx, x, y, cw, ch, ch / 2);
    ctx.fillStyle = tint(color, 0.2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + ch * 0.5, cy, ch * 0.17, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    const size = clamp(ch * 0.5, 10, 13);
    const font = `${size}px ${MONO}`;
    const label = fitSmart(ctx, n.label, font, cw - ch * 0.95);
    if (label !== n.label) st.nameHidden = true;
    if (!label) return;
    ctx.font = font;
    ctx.fillStyle = TEXT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + ch * 0.85, cy + 0.5);
  }

  /** Where a line attaches on a node: the tile, the chip, or (far away) the chip's dot. */
  function anchor(st: NodeState): Anchor {
    if (st.n.box) return { cx: st.sx + st.sw / 2, cy: st.sy + st.sh / 2, hw: st.sw / 2, hh: st.sh / 2 };
    const g = chipGeom(st);
    if (g.ca < 0.5) {
      const r = Math.max(1.5, g.ch * 0.17) + 3;
      return { cx: g.x + g.ch * 0.5, cy: g.cy, hw: r, hh: r };
    }
    return { cx: g.cx, cy: g.cy, hw: g.cw / 2, hh: g.ch / 2 };
  }

  function clip(a: Anchor, dx: number, dy: number, pad: number) {
    // point where the ray from the centre along (dx, dy) leaves the (padded) rectangle
    const sx = dx === 0 ? Infinity : (a.hw + pad) / Math.abs(dx);
    const sy = dy === 0 ? Infinity : (a.hh + pad) / Math.abs(dy);
    const s = Math.min(sx, sy);
    return { x: a.cx + dx * s, y: a.cy + dy * s };
  }

  /** Draws resting relationships; returns the focused ones as draw calls for the pass above the tiles. */
  function drawEdges(ctx: CanvasRenderingContext2D, model: MapModel, states: Map<string, NodeState>): (() => void)[] {
    const s = S.current;
    const selSet = subtree(s.selected);
    const hovSet = s.hover !== s.selected ? subtree(s.hover) : null;
    const focusAny = !!(selSet || hovSet);
    // an open focused box keeps its own inside lines bright
    const openFocus = [s.selected, s.hover].map((id) => (id ? states.get(id) : undefined)).find((st) => st && st.n.box && st.t >= 0.5);
    const openSet = openFocus ? subtree(openFocus.n.id) : null;

    // Spread each code-level edge over the nodes that currently stand in for its ends. A node stands in
    // with weight vis·(1−t) (visible but not open); weights along an ancestor chain sum to ~1.
    const standIns = (id: string): [string, number][] => {
      const n = model.nodes.get(id)!;
      const out: [string, number][] = [];
      for (const c of [id, ...n.ancestors]) {
        const st = states.get(c);
        if (!st) continue;
        const w = st.n.box ? st.vis * (1 - st.t) : st.vis;
        if (w > 0.02) out.push([c, w]);
      }
      return out;
    };
    const cache = new Map<string, [string, number][]>();
    const ends = (id: string) => {
      let r = cache.get(id);
      if (!r) cache.set(id, (r = standIns(id)));
      return r;
    };
    type Pair = { a: string; b: string; w: number; n: number; ext: number; sel: boolean; hov: boolean; kinds: Map<string, number> };
    const merged = new Map<string, Pair>();
    for (const e of model.edges) {
      const sel = !!selSet && selSet.has(e.source) !== selSet.has(e.target);
      const hov = !!hovSet && hovSet.has(e.source) !== hovSet.has(e.target);
      for (const [a, wa] of ends(e.source)) {
        for (const [b, wb] of ends(e.target)) {
          if (a === b) continue;
          const key = `${a}>${b}`;
          let m = merged.get(key);
          if (!m) merged.set(key, (m = { a, b, w: 0, n: 0, ext: 0, sel: false, hov: false, kinds: new Map() }));
          m.w += wa * wb;
          m.n += 1;
          if (e.external) m.ext += 1;
          m.sel ||= sel;
          m.hov ||= hov;
          m.kinds.set(e.kind, (m.kinds.get(e.kind) ?? 0) + 1);
        }
      }
    }
    const onTop: (() => void)[] = [];
    ctx.lineCap = "round";
    for (const m of merged.values()) {
      const sa = states.get(m.a)!;
      const sb = states.get(m.b)!;
      const strength = m.w / m.n; // how much this pair is "the" current view of these relationships
      if (strength < 0.03) continue;
      const touched = m.sel || m.hov;
      const A = anchor(sa);
      const B = anchor(sb);
      const inA = A.cx > 0 && A.cx < s.w && A.cy > 0 && A.cy < s.h;
      const inB = B.cx > 0 && B.cx < s.w && B.cy > 0 && B.cy < s.h;
      // lines to somewhere off-screen only matter for the item you are pointing at
      if (!(inA && inB) && !touched) continue;
      if (!inA && !inB) continue;
      const dx = B.cx - A.cx;
      const dy = B.cy - A.cy;
      const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      const p = clip(A, dx / len, dy / len, sa.n.box ? 0 : 2);
      const q = clip(B, -dx / len, -dy / len, sb.n.box ? 0 : 2);
      const seg = Math.hypot(q.x - p.x, q.y - p.y);
      if (seg < 2) continue;
      const kind = [...m.kinds.entries()].sort((x, y) => y[1] - x[1])[0][0] as EdgeKind;
      const bothBoxes = sa.n.box && sb.n.box;
      const rare = RARE_KINDS.has(kind) && !bothBoxes;
      const external = m.ext === m.n;
      const color = rare ? (EDGE_STYLE[kind]?.color ?? INK) : touched ? INK_FOCUS : INK;
      const local = sa.n.parent === sb.n.parent;
      let alpha = strength * (touched ? (m.sel ? 0.95 : 0.75) : local ? 0.55 : bothBoxes ? 0.22 : 0.1);
      if (focusAny && !touched && !(openSet && openSet.has(m.a) && openSet.has(m.b))) alpha *= 0.45;
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
      if (alpha < 0.01) continue;
      // gentle curve: the perpendicular flips with direction, so A→B and B→A bow apart into a lens
      const ux = (q.x - p.x) / seg;
      const uy = (q.y - p.y) / seg;
      const bend = seg < 30 ? 0 : Math.min(40, seg * 0.15);
      const mx = (p.x + q.x) / 2 - uy * bend;
      const my = (p.y + q.y) / 2 + ux * bend;
      const paint = () => {
        ctx.globalAlpha = 1;
        if (inA && inB) ctx.strokeStyle = withAlpha(color, alpha);
        else {
          // one end is off-screen: fade the line out towards it
          const g = ctx.createLinearGradient(p.x, p.y, q.x, q.y);
          g.addColorStop(inA ? 0 : 1, withAlpha(color, alpha));
          g.addColorStop(inA ? 1 : 0, withAlpha(color, 0));
          ctx.strokeStyle = g;
        }
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.setLineDash(dash.map((d) => d * Math.max(1, width * 0.8)));
        if (touched) {
          ctx.shadowColor = withAlpha(color, 0.55);
          ctx.shadowBlur = 6;
        }
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.quadraticCurveTo(mx, my, q.x, q.y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.shadowColor = "transparent";
        ctx.setLineDash([]);
        // arrowhead at the target, only where there is room for it
        if (arrow && inB && seg > 32 && alpha > 0.08) {
          const ang = Math.atan2(q.y - my, q.x - mx);
          const sz = Math.min(4 + width * 1.5, seg * 0.25);
          ctx.beginPath();
          ctx.moveTo(q.x, q.y);
          ctx.lineTo(q.x - sz * Math.cos(ang - 0.45), q.y - sz * Math.sin(ang - 0.45));
          ctx.lineTo(q.x - sz * Math.cos(ang + 0.45), q.y - sz * Math.sin(ang + 0.45));
          ctx.closePath();
          ctx.fillStyle = withAlpha(color, Math.min(1, alpha * 1.2));
          ctx.fill();
        }
      };
      if (touched) onTop.push(paint);
      else paint();
    }
    return onTop;
  }

  /** Selection: a blue ring (the app accent) with a soft glow; hover: a quiet light ring. An open box gets a
   *  thin outline instead, so the room you are in does not glow. */
  function drawRing(ctx: CanvasRenderingContext2D, states: Map<string, NodeState>, id: string, selectedRing: boolean) {
    const model = S.current.model!;
    const n = model.nodes.get(id);
    if (!n) return;
    // the node itself if visible, otherwise the tile that currently stands in for it
    const target = [id, ...n.ancestors]
      .map((x) => states.get(x))
      .find((st) => st && st.vis > 0.3 && (st.t < 0.5 || !st.n.box || st.n.id === id));
    if (!target) return;
    const a = anchor(target);
    const open = target.n.box && target.t >= 0.5;
    const r = target.n.box ? boxRadius(target.sw, target.sh) : Math.min(a.hh, a.hw);
    const pad = open ? 0 : 2;
    ctx.globalAlpha = selectedRing ? 1 : 0.7;
    if (selectedRing && !open) {
      ctx.shadowColor = withAlpha(ACCENT, 0.5);
      ctx.shadowBlur = 6;
    }
    ctx.lineWidth = open ? 1 : selectedRing ? 2 : 1.5;
    ctx.strokeStyle = selectedRing ? ACCENT : HOVER_RING;
    roundRect(ctx, a.cx - a.hw - pad, a.cy - a.hh - pad, a.hw * 2 + pad * 2, a.hh * 2 + pad * 2, r + pad);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  function updateCrumbs(model: MapModel, states: Map<string, NodeState>) {
    const s = S.current;
    const cx = s.w / 2;
    const cy = s.h / 2;
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
  function pick(px: number, py: number): NodeState | null {
    const s = S.current;
    if (!s.model) return null;
    let hit: NodeState | null = null;
    for (const st of s.states.values()) {
      if (st.vis < 0.5 || !st.onScreen) continue;
      if (st.n.box) {
        if (st.t >= 0.5) continue; // open frames are see-through
        if (px >= st.sx && px <= st.sx + st.sw && py >= st.sy && py <= st.sy + st.sh) {
          if (!hit || st.n.depth >= hit.n.depth) hit = st;
        }
      } else {
        const a = anchor(st);
        if (Math.abs(px - a.cx) <= a.hw && Math.abs(py - a.cy) <= a.hh) hit = st;
      }
    }
    return hit;
  }

  /** Re-check what is under a resting pointer after the camera moved (zoom with the mouse held still). */
  function refreshHover() {
    const s = S.current;
    if (!s.ptr) return;
    const hit = pick(s.ptr.x, s.ptr.y);
    const id = hit?.n.id ?? null;
    if (id !== s.hover) {
      s.hover = id;
      requestDraw();
    }
    if (s.tipShown) {
      s.tipShown = false;
      setTip(null); // no tooltips while the camera moves
    }
  }

  // ---- camera ----------------------------------------------------------------------------------------
  function transformFor(x1: number, y1: number, x2: number, y2: number, pad = 0.08): ZoomTransform {
    const s = S.current;
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    // keep the content above an overlay at the bottom (the key), unless that would leave too little room
    const inset = s.insetBottom < s.h * 0.35 ? s.insetBottom : 0;
    const ah = s.h - inset;
    const k = Math.min(s.w / (w * (1 + 2 * pad)), ah / (h * (1 + 2 * pad)), MAX_ZOOM);
    return zoomIdentity.translate(s.w / 2 - ((x1 + x2) / 2) * k, ah / 2 - ((y1 + y2) / 2) * k).scale(k);
  }

  function fly(t: ZoomTransform) {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.zoom) return;
    const sel = select(canvas);
    const v = s.view;
    if (Math.abs(t.x - v.x) < 4 && Math.abs(t.y - v.y) < 4 && Math.abs(t.k / v.k - 1) < 0.02) return; // already there
    sel.interrupt();
    if (document.visibilityState !== "visible" || s.reduced) {
      s.zoom.transform(sel, t);
      return;
    }
    // start from what is drawn (not d3's target, which may be ahead mid-glide), so a flight never jumps
    s.glide = false;
    s.flying = true;
    s.atHome = false;
    s.anchor = null;
    s.zoom.transform(sel, zoomIdentity.translate(v.x, v.y).scale(v.k));
    // short hops are quick, long trips unhurried: scale d3's own estimate of the "zoom out, travel, zoom
    // in" path length
    const p0: [number, number, number] = [(s.w / 2 - v.x) / v.k, (s.h / 2 - v.y) / v.k, s.w / v.k];
    const p1: [number, number, number] = [(s.w / 2 - t.x) / t.k, (s.h / 2 - t.y) / t.k, s.w / t.k];
    const duration = clamp(0.6 * interpolateZoom(p0, p1).duration, 400, 1100);
    sel
      .transition()
      .duration(duration)
      .ease(EASE_FLY)
      .call(s.zoom.transform, t)
      .on("end interrupt", () => {
        s.glide = true;
        s.flying = false;
        s.lastScaleAt = performance.now();
        requestDraw();
      });
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

  function zoomTo(id: string) {
    const m = S.current.model;
    const n = m?.nodes.get(id);
    if (!m || !n) return;
    const target = n.box ? n : (m.nodes.get(n.parent ?? "") ?? n);
    const r = target.rect;
    fly(transformFor(r.x - r.w / 2, r.y - r.h / 2, r.x + r.w / 2, r.y + r.h / 2));
  }

  /** One level out: the parent of the box you are in, or the overview. */
  function zoomOut() {
    const s = S.current;
    const up = s.crumbIds.length >= 2 ? s.crumbIds[s.crumbIds.length - 2] : null;
    if (up) zoomTo(up);
    else {
      const h = homeTransform();
      if (h) fly(h);
    }
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

  /** Size the canvas to its container. Measured directly (not only via ResizeObserver, which stays silent
   *  while a tab is hidden and for some first layouts). Returns whether there is room to draw. */
  function fitCanvas(): boolean {
    const s = S.current;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return false;
    const r = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width !== s.w || r.height !== s.h || dpr !== s.dpr) {
      s.dpr = dpr;
      s.w = r.width;
      s.h = r.height;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
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
    s.zoom.transform(select(canvas), home);
    s.view = { k: home.k, x: home.x, y: home.y };
    s.homed = true;
    s.atHome = true;
    api.current.requestDraw();
    if (s.selected && s.model.nodes.has(s.selected)) {
      const id = s.selected;
      setTimeout(() => api.current.zoomTo(id), 120);
    }
  }

  const api = useRef({ zoomTo, zoomOut, zoomToPath, homeTransform, fly, draw, pick, requestDraw, goHome, fitCanvas });
  useEffect(() => {
    api.current = { zoomTo, zoomOut, zoomToPath, homeTransform, fly, draw, pick, requestDraw, goHome, fitCanvas };
  });

  // ---- set up canvas, input and resize once ------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const s = S.current;

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
        if (t === "mousedown" || t === "touchstart") {
          s.held = true;
          canvas.style.cursor = "grabbing";
        }
      })
      .on("zoom", (e) => {
        const src = e.sourceEvent as (Event & { type: string }) | null;
        if (src) s.atHome = false;
        if (Math.abs(Math.log(e.transform.k) - Math.log(s.target.k)) > 1e-3) s.lastScaleAt = performance.now();
        s.target = e.transform;
        if (src?.type === "wheel") {
          const [px, py] = pointer(src, canvas);
          s.anchor = { x: px, y: py };
        } else if (!src) s.anchor = null;
        // dragging and pinching follow the fingers exactly; wheel zoom glides
        if (src && (src.type === "mousemove" || src.type === "pointermove" || src.type === "touchmove")) {
          s.view = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        }
        api.current.requestDraw();
      })
      .on("end", () => {
        s.held = false;
        canvas.style.cursor = s.hover ? "pointer" : "grab";
        api.current.requestDraw();
      });
    s.zoom = z;
    const sel = select(canvas);
    sel.call(z).on("dblclick.zoom", null);

    const local = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: MouseEvent) => {
      const p = local(e);
      s.ptr = p;
      const hit = api.current.pick(p.x, p.y);
      const id = hit?.n.id ?? null;
      if (!s.held) canvas.style.cursor = hit ? "pointer" : "grab";
      if (id !== s.hover) {
        s.hover = id;
        api.current.requestDraw();
      }
      const show = !!hit && !s.held && (!hit.n.box || hit.nameHidden);
      if (show) {
        s.tipShown = true;
        setTip({ x: p.x, y: p.y, node: hit!.n });
      } else if (s.tipShown) {
        s.tipShown = false;
        setTip(null);
      }
    };
    const onLeave = () => {
      s.hover = null;
      s.ptr = null;
      s.tipShown = false;
      setTip(null);
      api.current.requestDraw();
    };
    // d3-zoom swallows mousedown, so a drag is told apart from a click with pointer events
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    // A click selects at once (ring on the map), but tells the page only after a moment, so a double-click
    // can fly without first opening the details panel (which resizes the map).
    let clickTimer = 0;
    const onClick = (e: MouseEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // that was a drag
      const p = local(e);
      const hit = api.current.pick(p.x, p.y);
      const id = hit && !isSynthetic(hit.n.id) ? hit.n.id : null;
      s.selected = id;
      api.current.requestDraw();
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => cb.current.onSelect(id), 220);
    };
    const onDbl = (e: MouseEvent) => {
      window.clearTimeout(clickTimer);
      s.selected = s.selProp; // the double-click flies; it does not change the selection
      const p = local(e);
      const hit = api.current.pick(p.x, p.y);
      if (hit) api.current.zoomTo(hit.n.id);
      else api.current.zoomOut(); // empty space: one level out
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
    canvas.addEventListener("contextrestored", onRestored);
    document.addEventListener("visibilitychange", onVisible);

    // debugging/verification hook (no UI effect)
    (canvas as unknown as { __archon: unknown }).__archon = {
      state: s,
      draw: () => api.current.draw(),
      pick: (x: number, y: number) => api.current.pick(x, y)?.n ?? null,
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
      zoomTo: (id) => api.current.zoomTo(id),
      zoomToPath: (path) => api.current.zoomToPath(path),
      reset: () => {
        const h = api.current.homeTransform();
        if (h) api.current.fly(h);
      },
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
      canvas.removeEventListener("contextrestored", onRestored);
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
      s.anim.clear();
      s.subtrees.clear();
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
      .map((n) => ({ id: n.id, label: n.label, top: tint(n.hue, 0.34), bottom: tint(n.hue, 0.22), border: withAlpha(n.hue, 0.7) }));
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
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden" style={{ background: BG }}>
      <canvas ref={canvasRef} className="block touch-none select-none" style={{ cursor: "grab", opacity: 0 }} />
      {tip && (
        <div
          className="pointer-events-none absolute z-20 rounded-md border border-line bg-[#151922]/95 px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur"
          style={{ left: Math.min(tip.x + 14, (S.current.w || 400) - 280), top: tip.y + 16, maxWidth: 280 }}
        >
          <div className="mono text-fg break-all">{tip.node.fullLabel}</div>
          {tip.node.path && <div className="text-faint truncate">{tip.node.path}</div>}
          {(tip.node.summary.length > 0 || tip.node.lines > 0) && (
            <div className="text-muted mt-0.5">
              {[...tip.node.summary, tip.node.lines > 0 ? `${tip.node.lines} lines` : ""].filter(Boolean).join(" · ")}
            </div>
          )}
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
        <div className="absolute top-3 left-3 z-20 chip mono pointer-events-none text-[10px]">
          frame p50 {debug.p50.toFixed(1)} ms · p95 {debug.p95.toFixed(1)} ms · boxes {debug.boxes} · half-open {debug.half} ·{" "}
          {debug.settled ? "settled" : "moving"} · k {debug.k.toFixed(3)}
        </div>
      )}
    </div>
  );
}
