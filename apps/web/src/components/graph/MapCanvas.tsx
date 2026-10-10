"use client";

/**
 * Smooth semantic-zoom code map, rendered on a 2D canvas (decisions.md D-025).
 *
 * - Input: d3-zoom (wheel, pinch, drag, curved fly-to transitions). The drawn view eases toward d3's
 *   target every frame, so wheel zoom glides instead of stepping.
 * - Detail: every box has an "openness" t in [0, 1] from its size on screen (smoothstep). The tile fades
 *   out as t rises while its frame and children fade in — no popping, ever.
 * - Relationships: each code-level edge is spread over the levels currently on screen with weights that
 *   follow the same openness, so lines cross-fade from "folder ↔ folder" to "function ↔ function".
 * - Look: dot grid that scales with zoom, soft-shadowed gradient tiles, chips for symbols, glowing
 *   highlight for hover and selection, crisp text at every zoom (drawn in screen space).
 */
import { useEffect, useRef, useState } from "react";
import { select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { easeCubicInOut } from "d3-ease";
import "d3-transition";
import { EDGE_STYLE, KIND_STYLE, type EdgeKind, type Graph, type NodeKind } from "@/lib/api";
import { cachedLayout, computeLayout, viewKey } from "./layoutClient";
import { BG, buildMapModel, tint, withAlpha, type MapModel, type MapNode } from "./mapModel";
import { buildView, isSynthetic } from "./viewModel";

export interface Crumb {
  id: string;
  label: string;
}

export interface MapController {
  zoomTo: (id: string) => void;
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
const OPEN_AREA: [number, number] = [0.3, 0.48]; // share of the screen over which a box fades open
const OPEN_SPAN: [number, number] = [0.72, 0.84]; // …or share of the width/height (long boxes)
const GLIDE = 0.24; // per-frame easing of the drawn view toward the target (wheel zoom)
const MAX_ZOOM = 6;
const SANS = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
const TEXT = "#e6e9f0";
const MUTED = "#9aa3b5";

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface View {
  k: number;
  x: number;
  y: number;
}

interface NodeState {
  n: MapNode;
  vis: number; // how visible this node is (product of its ancestors' openness)
  tvis: number; // how visible its text is: children's names wait until the parent's name has faded
  t: number; // openness of this box (0 = tile, 1 = open frame); 0 for leaves
  sx: number; // screen rect (top-left, size)
  sy: number;
  sw: number;
  sh: number;
  onScreen: boolean;
}

type LayoutState = { state: "idle" } | { state: "running"; items: number } | { state: "error"; message: string };

export function MapCanvas({ graph, selected, onSelect, onCrumbs, onReady }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<LayoutState>({ state: "idle" });
  const [tip, setTip] = useState<{ x: number; y: number; node: MapNode } | null>(null);

  // Everything the frame loop needs lives in one mutable ref (no React re-render per frame).
  const S = useRef({
    model: null as MapModel | null,
    target: zoomIdentity as ZoomTransform,
    view: { k: 1, x: 0, y: 0 } as View,
    glide: true,
    w: 0,
    h: 0,
    dpr: 1,
    frame: 0 as number,
    states: new Map<string, NodeState>(),
    hover: null as string | null,
    selected: null as string | null,
    crumbKey: "",
    zoom: null as ZoomBehavior<HTMLCanvasElement, unknown> | null,
    textW: new Map<string, number>(),
    seq: 0,
    homeK: 0,
    homed: false, // home view applied (needs a real canvas size)
    drawError: "",
    pills: [] as (() => void)[],
  });
  const cb = useRef({ onSelect, onCrumbs, onReady });
  useEffect(() => {
    cb.current = { onSelect, onCrumbs, onReady };
  });

  useEffect(() => {
    S.current.selected = selected;
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
    s.frame = document.visibilityState === "visible" ? requestAnimationFrame(run) : (setTimeout(run, 0) as unknown as number);
  }

  // ---- geometry helpers ----------------------------------------------------------------------------
  function toScreen(v: View, r: MapNode["rect"]) {
    return { sx: (r.x - r.w / 2) * v.k + v.x, sy: (r.y - r.h / 2) * v.k + v.y, sw: r.w * v.k, sh: r.h * v.k };
  }

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

  function measure(ctx: CanvasRenderingContext2D, text: string, font: string): number {
    const key = `${font}|${text}`;
    const cache = S.current.textW;
    let w = cache.get(key);
    if (w === undefined) {
      ctx.font = font;
      w = ctx.measureText(text).width;
      if (cache.size > 5000) cache.clear();
      cache.set(key, w);
    }
    return w;
  }

  function fit(ctx: CanvasRenderingContext2D, text: string, font: string, max: number): string {
    if (measure(ctx, text, font) <= max) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (measure(ctx, `${text.slice(0, mid)}…`, font) <= max) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${text.slice(0, lo)}…` : "";
  }

  // ---- the frame ------------------------------------------------------------------------------------
  function draw() {
    try {
      renderFrame();
    } catch (err) {
      // show the failure instead of a silently blank map (reported once per message)
      const msg = err instanceof Error ? err.message : String(err);
      if (S.current.drawError !== msg) {
        S.current.drawError = msg;
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
    const ctx = canvas.getContext("2d")!;

    // ease the drawn view toward d3's target (zoom in log space so it feels even)
    const tv = s.target;
    const v = s.view;
    const a = s.glide && document.visibilityState === "visible" ? GLIDE : 1;
    const lk = Math.log(v.k) + (Math.log(tv.k) - Math.log(v.k)) * a;
    const nk = Math.exp(lk);
    // keep the point under the target's centre steady while k eases
    const cx = s.w / 2;
    const cy = s.h / 2;
    const wx = (cx - tv.x) / tv.k;
    const wy = (cy - tv.y) / tv.k;
    const curCx = (cx - v.x) / v.k;
    const curCy = (cy - v.y) / v.k;
    const mx = curCx + (wx - curCx) * a;
    const my = curCy + (wy - curCy) * a;
    v.k = nk;
    v.x = cx - mx * nk;
    v.y = cy - my * nk;
    const settled = Math.abs(lk - Math.log(tv.k)) < 1e-3 && Math.abs(mx - wx) * nk < 0.3 && Math.abs(my - wy) * nk < 0.3;
    if (settled) {
      v.k = tv.k;
      v.x = tv.x;
      v.y = tv.y;
    }

    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, s.w, s.h);
    drawGrid(ctx, v);

    // -- pass 0: openness / visibility for everything reachable on screen
    const states = new Map<string, NodeState>();
    const margin = 80;
    const forceRoot = model.roots.length === 1;
    const visit = (id: string, vis: number, tvis: number, forced: boolean) => {
      const n = model.nodes.get(id)!;
      const r = toScreen(v, n.rect);
      const onScreen = r.sx + r.sw > -margin && r.sx < s.w + margin && r.sy + r.sh > -margin && r.sy < s.h + margin;
      const t = onScreen ? openness(n, r.sw, r.sh, forced) : 0;
      states.set(id, { n, vis, tvis, t, ...r, onScreen });
      if (n.box && t > 0.005 && onScreen) for (const c of n.children) visit(c, vis * t, tvis * smooth(0.4, 0.8, t), false);
    };
    for (const r of model.roots) visit(r, 1, 1, forceRoot);
    s.states = states;

    const boxes = [...states.values()].filter((st) => st.n.box && st.onScreen).sort((x, y) => x.n.depth - y.n.depth);
    const leaves = [...states.values()].filter((st) => !st.n.box && st.onScreen && st.vis > 0.01);
    const focusId = s.hover ?? s.selected;

    // -- pass 1: open frames (under everything)
    for (const st of boxes) if (st.vis * st.t > 0.01) drawFrame(ctx, st, st.vis * st.t);
    // -- pass 2: relationships
    drawEdges(ctx, model, states, focusId);
    // -- pass 3: closed tiles, then symbol chips
    for (const st of boxes) if (st.vis * (1 - st.t) > 0.01) drawTile(ctx, st, st.vis * (1 - st.t));
    for (const st of leaves) drawChip(ctx, st, st.vis);
    for (const p of s.pills) p();
    s.pills = [];
    // -- pass 4: highlight
    if (s.selected) drawHalo(ctx, states, s.selected, "#f2f4f8");
    if (s.hover && s.hover !== s.selected) drawHalo(ctx, states, s.hover, "#c9d3e3");

    updateCrumbs(model, states);
    if (!settled) requestDraw();
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

  function drawFrame(ctx: CanvasRenderingContext2D, st: NodeState, alpha: number) {
    const { n, sx, sy, sw, sh } = st;
    const radius = Math.min(14, Math.max(4, sw * 0.02));
    ctx.globalAlpha = alpha;
    roundRect(ctx, sx, sy, sw, sh, radius);
    ctx.fillStyle = tint(n.hue, Math.min(0.05 + n.depth * 0.022, 0.13));
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(n.hue, 0.32);
    ctx.stroke();
    // title band: name on the left, contents on the right
    ctx.globalAlpha = st.tvis * smooth(0.15, 0.5, st.t); // the title band never collides with children
    if (ctx.globalAlpha < 0.02) return;
    const band = (n.rect.header ?? 20) * S.current.view.k;
    const size = Math.min(15, Math.max(10, band * 0.42));
    if (size * 1.2 > band && band < 12) return;
    const font = `600 ${size}px ${SANS}`;
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = n.hue;
    const ty = sy + Math.max(band, size * 1.8) / 2 + 2;
    const name = fit(ctx, n.label, font, sw * 0.6);
    ctx.fillText(name, sx + 12, ty);
    if (sw > 260) {
      const sub = `${Math.max(9, size - 2.5)}px ${SANS}`;
      ctx.font = sub;
      ctx.fillStyle = MUTED;
      ctx.textAlign = "right";
      ctx.fillText(fit(ctx, n.summary, sub, sw * 0.35), sx + sw - 12, ty);
    }
  }

  function drawTile(ctx: CanvasRenderingContext2D, st: NodeState, alpha: number) {
    const { n, sx, sy, sw, sh } = st;
    if (sw < 2 || sh < 2) return;
    const radius = Math.min(14, Math.max(3, Math.min(sw, sh) * 0.08));
    ctx.globalAlpha = alpha;
    // soft shadow lifts tiles off the background
    if (sw > 36) {
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = Math.min(22, sw * 0.08);
      ctx.shadowOffsetY = Math.min(6, sw * 0.02);
    }
    const g = ctx.createLinearGradient(0, sy, 0, sy + sh);
    g.addColorStop(0, tint(n.hue, 0.34));
    g.addColorStop(1, tint(n.hue, 0.22));
    roundRect(ctx, sx, sy, sw, sh, radius);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(n.hue, 0.7);
    ctx.stroke();
    // light top edge: a subtle "glass" highlight
    if (sh > 24) {
      ctx.beginPath();
      ctx.moveTo(sx + radius, sy + 1);
      ctx.lineTo(sx + sw - radius, sy + 1);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.stroke();
    }

    // text: name + summary, sized to the tile within 10–22 px; below the tile when it does not fit.
    // It fades out early while the tile opens, so it never overlaps the children's names.
    alpha = st.tvis * (1 - smooth(0, 0.35, st.t));
    if (alpha < 0.02) return;
    ctx.globalAlpha = alpha;
    const nameSize = Math.min(22, sw / Math.max(6, n.label.length * 0.62), sh / 3.2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (nameSize >= 10) {
      const font = `600 ${nameSize}px ${SANS}`;
      ctx.fillStyle = TEXT;
      const showSub = sh > nameSize * 3.4 && n.summary;
      const y = sy + sh / 2 - (showSub ? nameSize * 0.55 : 0);
      ctx.font = font;
      ctx.fillText(fit(ctx, n.label, font, sw - 16), sx + sw / 2, y);
      if (showSub) {
        const sub = `${Math.max(10, nameSize * 0.62)}px ${SANS}`;
        ctx.font = sub;
        ctx.fillStyle = withAlpha("#dfe5ee", 0.7);
        ctx.fillText(fit(ctx, n.summary, sub, sw - 16), sx + sw / 2, y + nameSize * 1.15);
      }
    } else if (sw > 6 && alpha > 0.3) {
      // the name goes in a pill under the tile, drawn after all tiles so neighbours never cover it
      S.current.pills.push(() => drawPill(ctx, n, sx, sy, sw, sh, alpha));
    }
  }

  function drawPill(ctx: CanvasRenderingContext2D, n: MapNode, sx: number, sy: number, sw: number, sh: number, alpha: number) {
    {
      const font = `600 11px ${SANS}`;
      const text = fit(ctx, n.label, font, 160);
      const tw = measure(ctx, text, font);
      ctx.globalAlpha = alpha * 0.95;
      roundRect(ctx, sx + sw / 2 - tw / 2 - 5, sy + sh + 3, tw + 10, 16, 6);
      ctx.fillStyle = "rgba(15,18,24,0.85)";
      ctx.fill();
      ctx.font = font;
      ctx.fillStyle = TEXT;
      ctx.fillText(text, sx + sw / 2, sy + sh + 11);
    }
  }

  function drawChip(ctx: CanvasRenderingContext2D, st: NodeState, alpha: number) {
    const { n } = st;
    const v = S.current.view;
    // chips sit in the node slot of the layout footprint (node slot above, label slot below)
    const wx = n.rect.x;
    const wy = n.rect.y + 9;
    const cw = Math.max(18, n.rect.w - 8) * v.k;
    const ch = 24 * v.k;
    const x = wx * v.k + v.x - cw / 2;
    const y = wy * v.k + v.y - ch / 2;
    if (x > S.current.w || y > S.current.h || x + cw < 0 || y + ch < 0) return;
    const color = KIND_STYLE[n.kind as NodeKind]?.color ?? n.hue;
    ctx.globalAlpha = alpha;
    if (ch < 15) {
      // too small to read a name: a soft dot (an empty capsule would look like a glitch)
      ctx.beginPath();
      ctx.arc(x + cw / 2, y + ch / 2, Math.min(4, Math.max(1.5, ch * 0.25)), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      return;
    }
    roundRect(ctx, x, y, cw, ch, ch / 2);
    ctx.fillStyle = tint(color, 0.2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.stroke();
    // kind dot
    ctx.beginPath();
    ctx.arc(x + ch * 0.5, y + ch / 2, ch * 0.17, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    const size = Math.min(13, ch * 0.46);
    ctx.globalAlpha = st.tvis;
    if (size >= 7) {
      const font = `${size}px ${MONO}`;
      ctx.font = font;
      ctx.fillStyle = TEXT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fit(ctx, n.label, font, cw - ch * 0.95), x + ch * 0.85, y + ch / 2 + 0.5);
    }
  }

  /** Where a line should attach on a node: the rectangle (tiles) or the chip (leaves). */
  function anchor(st: NodeState) {
    if (st.n.box) return { cx: st.sx + st.sw / 2, cy: st.sy + st.sh / 2, hw: st.sw / 2, hh: st.sh / 2 };
    const v = S.current.view;
    const cw = Math.max(18, st.n.rect.w - 8) * v.k;
    return { cx: st.n.rect.x * v.k + v.x, cy: (st.n.rect.y + 9) * v.k + v.y, hw: cw / 2, hh: 12 * v.k };
  }

  function clip(a: ReturnType<typeof anchor>, dx: number, dy: number) {
    // point where the ray from the centre along (dx, dy) leaves the rectangle
    const sx = dx === 0 ? Infinity : a.hw / Math.abs(dx);
    const sy = dy === 0 ? Infinity : a.hh / Math.abs(dy);
    const s = Math.min(sx, sy);
    return { x: a.cx + dx * s, y: a.cy + dy * s };
  }

  function drawEdges(ctx: CanvasRenderingContext2D, model: MapModel, states: Map<string, NodeState>, focusId: string | null) {
    // Spread each code-level edge over the nodes that currently stand in for its ends. A node stands in
    // with weight vis·(1−t) (it is visible but not open); weights along an ancestor chain sum to ~1.
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
    const merged = new Map<string, { a: string; b: string; w: number; n: number; kinds: Map<string, number> }>();
    for (const e of model.edges) {
      for (const [a, wa] of ends(e.source)) {
        for (const [b, wb] of ends(e.target)) {
          if (a === b) continue;
          const key = `${a}>${b}`;
          let m = merged.get(key);
          if (!m) merged.set(key, (m = { a, b, w: 0, n: 0, kinds: new Map() }));
          m.w += wa * wb;
          m.n += 1;
          m.kinds.set(e.kind, (m.kinds.get(e.kind) ?? 0) + 1);
        }
      }
    }
    ctx.lineCap = "round";
    for (const m of merged.values()) {
      const sa = states.get(m.a)!;
      const sb = states.get(m.b)!;
      const strength = m.w / m.n; // how much this pair is "the" current view of these relationships
      if (strength < 0.03) continue;
      const A = anchor(sa);
      const B = anchor(sb);
      const inA = A.cx > 0 && A.cx < S.current.w && A.cy > 0 && A.cy < S.current.h;
      const inB = B.cx > 0 && B.cx < S.current.w && B.cy > 0 && B.cy < S.current.h;
      if (!inA && !inB) continue;
      const dx = B.cx - A.cx;
      const dy = B.cy - A.cy;
      const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      const p = clip(A, dx / len, dy / len);
      const q = clip(B, -dx / len, -dy / len);
      const kind = [...m.kinds.entries()].sort((x, y) => y[1] - x[1])[0][0] as EdgeKind;
      const color = EDGE_STYLE[kind]?.color ?? "#8a96aa";
      const touched = focusId !== null && (m.a === focusId || m.b === focusId);
      // lines to somewhere off-screen only matter for the node you are pointing at
      if (!touched && !(inA && inB)) continue;
      const local = sa.n.parent === sb.n.parent;
      // lines inside one box carry the story; lines between boxes stay quiet (stronger on hover)
      const detailed = !sa.n.box || !sb.n.box;
      let alpha = strength * (touched ? 0.95 : local ? 0.55 : detailed ? 0.1 : 0.22);
      if (focusId && !touched) alpha *= 0.45;
      const width = (1 + 3 * Math.min(1, Math.log2(m.w + 1) / Math.log2(41))) * (touched ? 1.6 : 1);
      // gentle curve: bend perpendicular to the line, a fixed side per pair
      const bend = Math.min(60, len * 0.12) * (m.a < m.b ? 1 : -1);
      const mx = (p.x + q.x) / 2 - (dy / len) * bend;
      const my = (p.y + q.y) / 2 + (dx / len) * bend;
      ctx.globalAlpha = 1;
      if (inA && inB) {
        ctx.strokeStyle = withAlpha(color, alpha);
      } else {
        // one end is off-screen: fade the line out towards it
        const g = ctx.createLinearGradient(p.x, p.y, q.x, q.y);
        g.addColorStop(inA ? 0 : 1, withAlpha(color, alpha));
        g.addColorStop(inA ? 1 : 0, withAlpha(color, 0));
        ctx.strokeStyle = g;
      }
      ctx.lineWidth = width;
      if (touched) {
        ctx.shadowColor = withAlpha(color, 0.8);
        ctx.shadowBlur = 8;
      }
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(mx, my, q.x, q.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      // arrowhead at the target
      if (inB && alpha > 0.08) {
        const ang = Math.atan2(q.y - my, q.x - mx);
        const s = 4 + width * 1.5;
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x - s * Math.cos(ang - 0.45), q.y - s * Math.sin(ang - 0.45));
        ctx.lineTo(q.x - s * Math.cos(ang + 0.45), q.y - s * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fillStyle = withAlpha(color, Math.min(1, alpha * 1.2));
        ctx.fill();
      }
    }
  }

  function drawHalo(ctx: CanvasRenderingContext2D, states: Map<string, NodeState>, id: string, color: string) {
    const model = S.current.model!;
    const n = model.nodes.get(id);
    if (!n) return;
    // highlight the node itself if visible, otherwise the tile that currently stands in for it
    const target = [id, ...n.ancestors]
      .map((x) => states.get(x))
      .find((st) => st && st.vis > 0.3 && (st.t < 0.5 || !st.n.box || st.n.id === id));
    if (!target) return;
    const a = anchor(target);
    const r = target.n.box ? Math.min(14, Math.max(3, Math.min(target.sw, target.sh) * 0.08)) : a.hh;
    ctx.globalAlpha = 1;
    ctx.shadowColor = withAlpha(target.n.box ? target.n.hue : (KIND_STYLE[target.n.kind as NodeKind]?.color ?? color), 0.9);
    ctx.shadowBlur = 16;
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    roundRect(ctx, a.cx - a.hw - 2, a.cy - a.hh - 2, a.hw * 2 + 4, a.hh * 2 + 4, r + 2);
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
    cb.current.onCrumbs?.(shown.map((id) => ({ id, label: model.nodes.get(id)!.label })));
  }

  // ---- picking -------------------------------------------------------------------------------------
  function pick(px: number, py: number): MapNode | null {
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
    return hit?.n ?? null;
  }

  // ---- camera ----------------------------------------------------------------------------------------
  function transformFor(x1: number, y1: number, x2: number, y2: number, pad = 0.08): ZoomTransform {
    const s = S.current;
    const w = Math.max(1, x2 - x1);
    const h = Math.max(1, y2 - y1);
    const k = Math.min(s.w / (w * (1 + 2 * pad)), s.h / (h * (1 + 2 * pad)), MAX_ZOOM);
    return zoomIdentity.translate(s.w / 2 - ((x1 + x2) / 2) * k, s.h / 2 - ((y1 + y2) / 2) * k).scale(k);
  }

  function fly(t: ZoomTransform) {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.zoom) return;
    const sel = select(canvas);
    if (document.visibilityState !== "visible") {
      s.zoom.transform(sel, t);
      return;
    }
    // d3 interpolates zoom transitions along a smooth "zoom out, travel, zoom in" curve
    s.glide = false;
    sel
      .transition()
      .duration(850)
      .ease(easeCubicInOut)
      .call(s.zoom.transform, t)
      .on("end interrupt", () => {
        s.glide = true;
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

  /** Put the camera on the overview. Waits until the canvas has a real size: fitting into a 0×0 box would
   *  give zoom 0 and a map that never appears. */
  function goHome() {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!s.model || !canvas || !s.zoom || s.w < 2 || s.h < 2) return;
    const home = homeTransform();
    if (!home || !Number.isFinite(home.k) || home.k <= 0) return;
    s.homeK = home.k;
    s.zoom.scaleExtent([home.k * 0.5, MAX_ZOOM]);
    s.zoom.transform(select(canvas), home);
    s.view = { k: home.k, x: home.x, y: home.y };
    s.homed = true;
    if (s.selected && s.model.nodes.has(s.selected)) {
      const id = s.selected;
      setTimeout(() => api.current.zoomTo(id), 120);
    }
  }

  const api = useRef({ zoomTo, zoomToPath, homeTransform, fly, draw, pick, requestDraw, goHome });
  useEffect(() => {
    api.current = { zoomTo, zoomToPath, homeTransform, fly, draw, pick, requestDraw, goHome };
  });

  // ---- set up canvas, input and resize once ------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const s = S.current;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      s.dpr = window.devicePixelRatio || 1;
      s.w = r.width;
      s.h = r.height;
      canvas.width = Math.round(r.width * s.dpr);
      canvas.height = Math.round(r.height * s.dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      if (!s.homed) api.current.goHome();
      api.current.requestDraw();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const z = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.01, MAX_ZOOM])
      // finer wheel steps than d3's default; the frame loop then glides between them
      .wheelDelta((e) => -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.0016))
      .filter((e) => (!e.ctrlKey || e.type === "wheel") && !e.button && e.type !== "dblclick")
      .on("zoom", (e) => {
        s.target = e.transform;
        // dragging should follow the pointer exactly; wheel and pinch glide
        const src = e.sourceEvent as Event | null;
        if (src && (src.type === "mousemove" || src.type === "pointermove" || src.type === "touchmove")) {
          s.view = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        }
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
      const n = api.current.pick(p.x, p.y);
      const id = n?.id ?? null;
      canvas.style.cursor = n ? "pointer" : "grab";
      if (id !== s.hover) {
        s.hover = id;
        api.current.requestDraw();
      }
      setTip(n ? { x: p.x, y: p.y, node: n } : null);
    };
    const onLeave = () => {
      s.hover = null;
      setTip(null);
      api.current.requestDraw();
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // that was a drag
      const p = local(e);
      const n = api.current.pick(p.x, p.y);
      cb.current.onSelect(n && !isSynthetic(n.id) ? n.id : null);
    };
    const onDbl = (e: MouseEvent) => {
      const p = local(e);
      const n = api.current.pick(p.x, p.y);
      if (n) api.current.zoomTo(n.id);
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("dblclick", onDbl);

    // debugging/verification hook (no UI effect)
    (canvas as unknown as { __archon: unknown }).__archon = {
      state: s,
      draw: () => api.current.draw(),
      pick: (x: number, y: number) => api.current.pick(x, y),
      zoomTo: (id: string) => api.current.zoomTo(id),
    };

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
      sel.on(".zoom", null);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDbl);
      if (s.frame) cancelAnimationFrame(s.frame);
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
      s.model = buildMapModel(view, pos);
      s.drawError = "";
      setLayout({ state: "idle" });
      s.homed = false;
      api.current.goHome(); // or on the first resize with a real size
      api.current.requestDraw();
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

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden" style={{ background: BG }}>
      <canvas ref={canvasRef} className="block touch-none select-none" style={{ cursor: "grab" }} />
      {tip && !tip.node.box && (
        <div
          className="pointer-events-none absolute z-20 rounded-md border border-line bg-[#151922]/95 px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur"
          style={{ left: Math.min(tip.x + 14, (S.current.w || 400) - 260), top: tip.y + 14, maxWidth: 260 }}
        >
          <div className="mono text-fg">{tip.node.label}</div>
          <div className="text-faint truncate">{tip.node.path}</div>
        </div>
      )}
      {layout.state === "running" && (
        <div className="absolute top-3 right-3 z-10 chip pointer-events-none">
          <span className="h-1.5 w-1.5 rounded-full bg-accent pulse" /> arranging {layout.items} items…
        </div>
      )}
      {layout.state === "error" && (
        <div className="absolute top-3 right-3 z-10 chip text-danger border-danger/40">{layout.message}</div>
      )}
    </div>
  );
}
