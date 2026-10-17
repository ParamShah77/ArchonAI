"use client";

/**
 * Graph view: a Neo4j-style node-link graph of the code, drawn on a 2D canvas (decisions.md D-032).
 *
 * - Physics: d3-force (links, many-body charge, collision) runs live, a few ticks per frame, so the graph
 *   settles visibly; positions are remembered per repository, so returning or filtering does not reshuffle.
 * - Detail grows as you zoom in: far away coloured dots and the lines; then the names of the main nodes
 *   beside their circles; then every name inside its circle; then the relationship type on every line.
 *   The part you zoom into becomes clearer and clearer.
 * - Interaction: pan/zoom with a glide (d3-zoom), drag nodes (they stay where you drop them), click to
 *   inspect, double-click to fly in; the selection and its neighbours stay bright while the rest dims.
 */
import { useEffect, useRef, useState } from "react";
import type { Simulation } from "d3-force";
import { pointer, select } from "d3-selection";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { interpolateZoom } from "d3-interpolate";
import "d3-transition";
import type { MapController } from "./MapCanvas";
import { GRAPH_COLORS, GRAPH_KIND_LABEL, makeSimulation, relLabel, seedPositions, type GNode, type GraphData, type SimLink } from "./forceData";
import type { ForceRequest, ForceResponse } from "./force.worker";
import { fitSmart, fontOf, measure, type FontSpec } from "./mapText";
import { MAP_BG, MAP_PANEL, mixOklab } from "./palette";

interface Props {
  data: GraphData;
  cacheKey: string; // positions are remembered under this key (repository + version)
  selected: string | null;
  onSelect: (id: string | null) => void;
  onReady?: (ctrl: MapController) => void;
  insetRight?: number; // px covered by a side panel
}

const MAX_ZOOM = 6;
const GLIDE_MS = 65;
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const EDGE = "#8b95a8";
const EDGE_FOCUS = "#e6ebf3";
const ACCENT = "#5aa9ff";
const NODE_TEXT = "#14171d";
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const sans = (weight: number, size: number): FontSpec => ({ weight, size, family: SANS });
const posCache = new Map<string, Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>>();
const darker = new Map<string, string>();
const strokeOf = (c: string) => {
  let d = darker.get(c);
  if (!d) darker.set(c, (d = mixOklab(c, "#000000", 0.35)));
  return d;
};

type L = SimLink;

export function ForceGraph({ data, cacheKey, selected, onSelect, onReady, insetRight = 0 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; node: GNode } | null>(null);
  const S = useRef({
    sim: null as Simulation<GNode, L> | null,
    nodes: [] as GNode[],
    links: [] as L[],
    byId: new Map<string, GNode>(),
    nbrs: new Map<string, Set<string>>(),
    hubCut: Infinity,
    zoom: null as ZoomBehavior<HTMLCanvasElement, unknown> | null,
    target: zoomIdentity as ZoomTransform,
    view: { k: 1, x: 0, y: 0 },
    anchor: null as { x: number; y: number } | null,
    glide: true,
    w: 0,
    h: 0,
    dpr: 1,
    frame: 0,
    frameByTimer: false,
    lastT: 0,
    hover: null as string | null,
    selected: null as string | null,
    preview: null as string | null,
    drag: null as { node: GNode; moved: boolean; x0: number; y0: number } | null,
    autoFit: true, // keep the whole graph in view while it first settles (until you take over)
    placed: false,
    insetRight: 0,
    tipShown: false,
    cacheKey: "",
    worker: null as Worker | null,
    job: 0,
    settled: false, // a layout has finished settling once (later changes only need a nudge)
    settling: false, // the worker is settling the layout; the live simulation only runs after drags
  });
  const cb = useRef({ onSelect, onReady });
  useEffect(() => {
    cb.current = { onSelect, onReady };
  });

  useEffect(() => {
    S.current.selected = selected;
    api.current.requestDraw();
  }, [selected]);
  useEffect(() => {
    S.current.insetRight = insetRight;
    api.current.requestDraw();
  }, [insetRight]);

  // ---- frames -------------------------------------------------------------------------------------------
  function requestDraw() {
    const s = S.current;
    if (s.frame) return;
    const run = () => {
      s.frame = 0;
      frame();
    };
    s.frameByTimer = document.visibilityState !== "visible";
    s.frame = s.frameByTimer ? (setTimeout(run, 0) as unknown as number) : requestAnimationFrame(run);
  }

  function fitCanvas(): boolean {
    const s = S.current;
    const c = canvasRef.current;
    const w = wrapRef.current;
    if (!c || !w) return false;
    const r = w.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (r.width !== s.w || r.height !== s.h || dpr !== s.dpr) {
      s.w = r.width;
      s.h = r.height;
      s.dpr = dpr;
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
    }
    return s.w > 2 && s.h > 2;
  }

  function bounds(nodes: GNode[]) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of nodes) {
      x1 = Math.min(x1, (n.x ?? 0) - n.r);
      y1 = Math.min(y1, (n.y ?? 0) - n.r);
      x2 = Math.max(x2, (n.x ?? 0) + n.r);
      y2 = Math.max(y2, (n.y ?? 0) + n.r);
    }
    return { x1, y1, x2, y2 };
  }

  function fitTransform(nodes: GNode[], pad = 0.08): ZoomTransform | null {
    const s = S.current;
    if (!nodes.length) return null;
    const b = bounds(nodes);
    const vw = s.w - (s.insetRight < s.w * 0.6 ? s.insetRight : 0);
    const k = clamp(Math.min(vw / ((b.x2 - b.x1) * (1 + 2 * pad)), s.h / ((b.y2 - b.y1) * (1 + 2 * pad))), 0.05, MAX_ZOOM);
    return zoomIdentity.translate(vw / 2 - ((b.x1 + b.x2) / 2) * k, s.h / 2 - ((b.y1 + b.y2) / 2) * k).scale(k);
  }

  function frame() {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.zoom || !fitCanvas()) return;
    const ctx = canvas.getContext("2d")!;
    const now = performance.now();
    const dt = s.lastT ? Math.min(50, now - s.lastT) : 16;
    s.lastT = now;
    const visible = document.visibilityState === "visible";

    // -- physics: a few ticks per frame within a small time budget, until the graph has settled
    let moving = s.settling;
    if (s.sim && !s.settling && s.sim.alpha() > s.sim.alphaMin()) {
      const t0 = performance.now();
      let n = 0;
      do {
        s.sim.tick();
        n++;
      } while (n < 6 && performance.now() - t0 < 7 && s.sim.alpha() > s.sim.alphaMin());
      moving = true;
      if (s.sim.alpha() <= s.sim.alphaMin()) savePositions();
    }
    if (moving && s.autoFit) {
      const t = fitTransform(s.nodes);
      if (t) {
        s.zoom.transform(select(canvas), t); // d3 keeps the target; the view glides after it
        s.anchor = null;
      }
    }

    // -- camera glide toward d3's target
    const tv = s.target, v = s.view;
    const a = s.glide && visible ? 1 - Math.exp(-dt / GLIDE_MS) : 1;
    const anc = s.anchor ?? { x: s.w / 2, y: s.h / 2 };
    const lk = Math.log(v.k) + (Math.log(tv.k) - Math.log(v.k)) * a;
    const nk = Math.exp(lk);
    const wx = (anc.x - v.x) / v.k + ((anc.x - tv.x) / tv.k - (anc.x - v.x) / v.k) * a;
    const wy = (anc.y - v.y) / v.k + ((anc.y - tv.y) / tv.k - (anc.y - v.y) / v.k) * a;
    v.k = nk;
    v.x = anc.x - wx * nk;
    v.y = anc.y - wy * nk;
    const camSettled = Math.abs(lk - Math.log(tv.k)) < 1e-3 && Math.abs(v.x - tv.x) < 0.3 && Math.abs(v.y - tv.y) < 0.3;
    if (camSettled) {
      v.k = tv.k;
      v.x = tv.x;
      v.y = tv.y;
    }
    draw(ctx);
    if (moving || !camSettled) requestDraw();
  }

  // ---- drawing --------------------------------------------------------------------------------------------
  function draw(ctx: CanvasRenderingContext2D) {
    const s = S.current;
    const { k, x: tx, y: ty } = s.view;
    const X = (n: GNode) => (n.x ?? 0) * k + tx;
    const Y = (n: GNode) => (n.y ?? 0) * k + ty;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, s.w, s.h);
    drawGrid(ctx);

    const focus = s.selected && s.byId.has(s.selected) ? s.selected : null;
    const fset = focus ? s.nbrs.get(focus) : null;
    const hover = s.hover;
    const hset = hover ? s.nbrs.get(hover) : null;
    const onScreen = (x: number, y: number, r: number) => x + r > -40 && x - r < s.w + 40 && y + r > -40 && y - r < s.h + 40;

    // -- relationships: lines from circle edge to circle edge; arrows, then type labels, as you zoom in
    const baseA = 0.1 + 0.3 * smooth(0.15, 1.2, k);
    const arrowA = smooth(0.35, 0.6, k);
    const labelZoom = smooth(1.2, 1.7, k);
    ctx.lineCap = "round";
    const labels: { x: number; y: number; hw: number; hh: number; lit: boolean; draw: () => void }[] = [];
    for (const l of s.links) {
      const a = l.source, b = l.target;
      const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
      if (!onScreen(ax, ay, a.r * k) && !onScreen(bx, by, b.r * k)) continue;
      const lit = (focus && (a.id === focus || b.id === focus)) || (hover && (a.id === hover || b.id === hover));
      const dim = focus && !lit;
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len, uy = dy / len;
      const ra = a.r * k, rb = b.r * k;
      if (len <= ra + rb + 1) continue;
      const px = ax + ux * ra, py = ay + uy * ra;
      const qx = bx - ux * (rb + 1), qy = by - uy * (rb + 1);
      // long lines cross between far clusters: they fade with length so the stars stay readable
      const far = l.kind === "contains" ? 1 : 1 - 0.7 * smooth(220, 900, len);
      const alpha = lit ? 0.95 : (dim ? baseA * 0.3 : baseA) * far;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = lit ? EDGE_FOCUS : EDGE;
      ctx.lineWidth = lit ? 1.8 : 1;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(qx, qy);
      ctx.stroke();
      const showArrow = lit ? 1 : arrowA;
      if (showArrow > 0.02 && len - ra - rb > 14) {
        const sz = lit ? 8 : 6;
        ctx.globalAlpha = alpha * showArrow;
        ctx.beginPath();
        ctx.moveTo(qx, qy);
        ctx.lineTo(qx - ux * sz - uy * sz * 0.5, qy - uy * sz + ux * sz * 0.5);
        ctx.lineTo(qx - ux * sz + uy * sz * 0.5, qy - uy * sz - ux * sz * 0.5);
        ctx.closePath();
        ctx.fillStyle = lit ? EDGE_FOCUS : EDGE;
        ctx.fill();
      }
      // the relationship type along the line, once it is long enough on screen to hold it
      const la = (lit ? smooth(0.5, 0.8, k) : labelZoom) * (dim ? 0.3 : 1);
      const free = len - ra - rb;
      // long lines run between far clusters: their type is noise until you follow one (select an end)
      if (la > 0.02 && (lit || len < 420)) {
        const size = clamp(7.5 * k, 8, 11);
        const font = sans(600, size);
        const text = relLabel(l.kind);
        const tw = measure(ctx, text, font);
        if (tw + 10 < free) {
          // the label's screen box (axis-aligned around the rotated text) for the overlap test
          const ux2 = Math.abs(ux), uy2 = Math.abs(uy);
          labels.push({
            x: (px + qx) / 2,
            y: (py + qy) / 2,
            hw: (ux2 * (tw + 6) + uy2 * size * 1.2) / 2,
            hh: (uy2 * (tw + 6) + ux2 * size * 1.2) / 2,
            lit: !!lit,
            draw: () => {
              const mx = (px + qx) / 2, my = (py + qy) / 2;
              let ang = Math.atan2(dy, dx);
              if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI; // keep text upright
              ctx.save();
              ctx.translate(mx, my);
              ctx.rotate(ang);
              ctx.globalAlpha = Math.min(1, la * (lit ? 1 : 0.9));
              ctx.fillStyle = MAP_BG; // the line breaks around its label, as in Neo4j
              ctx.fillRect(-tw / 2 - 3, -size * 0.6, tw + 6, size * 1.2);
              ctx.font = fontOf(font);
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = lit ? EDGE_FOCUS : "#aeb6c4";
              ctx.fillText(text, 0, 0.5);
              ctx.restore();
            },
          });
        }
      }
    }
    // line labels never pile up: lit ones first, then the rest where there is room
    labels.sort((p, q) => Number(q.lit) - Number(p.lit));
    const placed: typeof labels = [];
    for (const b of labels) {
      if (placed.some((o) => Math.abs(o.x - b.x) < o.hw + b.hw && Math.abs(o.y - b.y) < o.hh + b.hh)) continue;
      placed.push(b);
      b.draw();
    }

    // -- nodes: dots far away, circles with their name inside close up; the focus and its neighbours on top
    const order = [...s.nodes].sort((p, q) => rank(p) - rank(q));
    function rank(n: GNode) {
      if (n.id === focus || n.id === hover) return 3;
      if ((fset && fset.has(n.id)) || (hset && hset.has(n.id))) return 2;
      return 1;
    }
    const outside: { x: number; y: number; w: number; h: number; draw: () => void; pri: number }[] = [];
    for (const n of order) {
      const x = X(n), y = Y(n), r = n.r * k;
      if (!onScreen(x, y, r)) continue;
      const near = n.id === focus || n.id === hover || !!fset?.has(n.id) || !!hset?.has(n.id);
      const dim = focus && !(n.id === focus || fset?.has(n.id));
      const color = GRAPH_COLORS[n.kind] ?? "#9aa3b5";
      ctx.globalAlpha = dim ? 0.28 : 1;
      if (r < 1.6) {
        ctx.fillStyle = color;
        ctx.fillRect(x - 1, y - 1, 2, 2);
        continue;
      }
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (r > 4) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = strokeOf(color);
        ctx.stroke();
      }
      if (n.id === focus || n.id === s.preview) {
        ctx.globalAlpha = 1;
        ctx.shadowColor = "rgba(90,169,255,0.6)";
        ctx.shadowBlur = 8;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = ACCENT;
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.shadowColor = "transparent";
      } else if (n.id === hover) {
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#e6ebf3";
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      // the name moves inside the circle once the circle can hold all of it (a very long name settles for a
      // shortened one only when the circle is big); until then it sits beside the circle, whole and readable
      // the text shrinks a little (down to 9 px) to fit whole before it is ever shortened
      const top = clamp(r * 0.42, 9, 13);
      const w13 = measure(ctx, n.label, sans(600, 13));
      const fitSize = Math.min(top, (13 * r * 1.75) / Math.max(1, w13));
      const whole = fitSize >= 9;
      const inFont = sans(600, whole ? fitSize : top);
      // hand-off without a double: the name beside the circle fades out first, then the one inside fades in
      const [h0, h1] = whole ? [20, 23] : [44, 48];
      const inA = smooth(h1, h1 + 3, r);
      const besideA = 1 - smooth(h0, h1, r);
      if (inA > 0.02) {
        const font = inFont;
        const text = whole ? n.label : fitSmart(ctx, n.label, font, r * 1.75);
        if (text) {
          ctx.globalAlpha = inA * (dim ? 0.35 : 1);
          ctx.font = fontOf(font);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = NODE_TEXT;
          ctx.fillText(text, x, y + 0.5);
        }
      }
      // before that, the important ones (hubs, the focus, what you point at) carry their name beside them
      const hub = n.degree >= s.hubCut;
      const outA = besideA * (near ? 1 : hub ? smooth(0.12, 0.2, k) : smooth(0.55, 0.8, k));
      if (outA > 0.05 && !dim) {
        const font = sans(600, near ? 12 : 11);
        const text = fitSmart(ctx, n.label, font, 160);
        const tw = measure(ctx, text, font);
        const ly = y + r + 9;
        outside.push({
          x: x - tw / 2 - 2,
          y: ly - 7,
          w: tw + 4,
          h: 14,
          pri: near ? 3 : hub ? 2 : 1,
          draw: () => {
            ctx.globalAlpha = outA;
            ctx.font = fontOf(font);
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.lineWidth = 3;
            ctx.strokeStyle = MAP_BG;
            ctx.strokeText(text, x, ly);
            ctx.fillStyle = "#dfe5ee";
            ctx.fillText(text, x, ly);
          },
        });
      }
    }
    // outside names never overlap: the more important ones win
    outside.sort((p, q) => q.pri - p.pri);
    const taken: typeof outside = [];
    for (const o of outside) {
      if (taken.some((t) => o.x < t.x + t.w && t.x < o.x + o.w && o.y < t.y + t.h && t.y < o.y + o.h)) continue;
      taken.push(o);
      o.draw();
    }
    ctx.globalAlpha = 1;
  }

  function drawGrid(ctx: CanvasRenderingContext2D) {
    const s = S.current;
    const { k, x, y } = s.view;
    const base = Math.pow(2, Math.floor(Math.log2(24 / k)));
    const px = base * 2 * k;
    if (px < 10) return;
    const d = s.dpr;
    const sz = 2 / d;
    ctx.fillStyle = "rgba(150,165,190,0.10)";
    ctx.beginPath();
    const x0 = ((x % px) + px) % px, y0 = ((y % px) + px) % px;
    for (let gx = x0; gx < s.w; gx += px) for (let gy = y0; gy < s.h; gy += px) ctx.rect(Math.round(gx * d) / d - sz / 2, Math.round(gy * d) / d - sz / 2, sz, sz);
    ctx.fill();
  }

  // ---- picking & camera -------------------------------------------------------------------------------------
  function pick(px: number, py: number): GNode | null {
    const s = S.current;
    const { k, x, y } = s.view;
    let best: GNode | null = null;
    let bd = Infinity;
    for (const n of s.nodes) {
      const dx = (n.x ?? 0) * k + x - px, dy = (n.y ?? 0) * k + y - py;
      const d = Math.hypot(dx, dy);
      const r = Math.max(5, n.r * k);
      if (d <= r + 2 && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  function fly(t: ZoomTransform | null) {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!t || !canvas || !s.zoom) return;
    s.autoFit = false;
    const sel = select(canvas);
    sel.interrupt();
    if (document.visibilityState !== "visible") {
      s.zoom.transform(sel, t);
      return;
    }
    const v = s.view;
    s.glide = false;
    s.anchor = null;
    s.zoom.transform(sel, zoomIdentity.translate(v.x, v.y).scale(v.k));
    const p0: [number, number, number] = [(s.w / 2 - v.x) / v.k, (s.h / 2 - v.y) / v.k, s.w / v.k];
    const p1: [number, number, number] = [(s.w / 2 - t.x) / t.k, (s.h / 2 - t.y) / t.k, s.w / t.k];
    sel
      .transition()
      .duration(clamp(0.6 * interpolateZoom(p0, p1).duration, 400, 1000))
      .call(s.zoom.transform, t)
      .on("end interrupt", () => {
        s.glide = true;
        requestDraw();
      });
  }

  function zoomTo(id: string) {
    const s = S.current;
    const n = s.byId.get(id);
    if (!n) return;
    const k = Math.max(s.view.k, 1.6);
    const vw = s.w - (s.insetRight < s.w * 0.6 ? s.insetRight : 0);
    fly(zoomIdentity.translate(vw / 2 - (n.x ?? 0) * k, s.h / 2 - (n.y ?? 0) * k).scale(k));
  }

  function zoomBy(f: number) {
    const s = S.current;
    const canvas = canvasRef.current;
    if (!canvas || !s.zoom) return;
    s.autoFit = false;
    s.anchor = { x: s.w / 2, y: s.h / 2 };
    s.zoom.scaleBy(select(canvas), f, [s.w / 2, s.h / 2]);
  }

  function savePositions() {
    const s = S.current;
    const m = new Map<string, { x: number; y: number; fx?: number | null; fy?: number | null }>();
    for (const n of s.nodes) m.set(n.id, { x: n.x ?? 0, y: n.y ?? 0, fx: n.fx, fy: n.fy });
    posCache.set(s.cacheKey, m);
  }

  const api = useRef({ requestDraw, pick, zoomTo, zoomBy, fly, fitTransform, savePositions });
  useEffect(() => {
    api.current = { requestDraw, pick, zoomTo, zoomBy, fly, fitTransform, savePositions };
  });

  // ---- canvas, input --------------------------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const s = S.current;
    const ro = new ResizeObserver(() => {
      fitCanvas();
      api.current.requestDraw();
    });
    ro.observe(wrap);
    fitCanvas();
    const local = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const z = d3zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.04, MAX_ZOOM])
      .wheelDelta((e) => clamp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.0025) * (e.ctrlKey ? 8 : 1), -0.5, 0.5))
      // pressing on a node drags the node, not the map
      .filter((e) => {
        if ((e.type === "mousedown" || e.type === "touchstart") && e instanceof MouseEvent && api.current.pick(local(e).x, local(e).y)) return false;
        return (!e.ctrlKey || e.type === "wheel") && !e.button && e.type !== "dblclick";
      })
      .on("zoom", (e) => {
        const src = e.sourceEvent as (Event & { type: string }) | null;
        if (src) s.autoFit = false;
        s.target = e.transform;
        if (src?.type === "wheel") {
          const [px, py] = pointer(src, canvas);
          s.anchor = { x: px, y: py };
        }
        if (src && (src.type === "mousemove" || src.type === "touchmove")) s.view = { k: e.transform.k, x: e.transform.x, y: e.transform.y };
        api.current.requestDraw();
      });
    s.zoom = z;
    const sel = select(canvas);
    sel.call(z).on("dblclick.zoom", null);
    z.transform(sel, zoomIdentity);

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = local(e);
      const n = api.current.pick(p.x, p.y);
      if (!n) return;
      s.drag = { node: n, moved: false, x0: p.x, y0: p.y };
      canvas.setPointerCapture(e.pointerId);
      setTip(null);
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (s.drag) {
        const d = s.drag;
        if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) < 4) return;
        if (!d.moved) {
          d.moved = true;
          s.autoFit = false;
          if (s.settling) {
            // you take over: the live simulation finishes the settling around your hand
            s.job++;
            s.worker?.terminate();
            s.worker = null;
            s.settling = false;
            s.sim?.alpha(0.5);
          }
          s.sim?.alphaTarget(0.25);
          if (s.sim && s.sim.alpha() < 0.25) s.sim.alpha(0.25);
        }
        const { k, x, y } = s.view;
        d.node.fx = (p.x - x) / k;
        d.node.fy = (p.y - y) / k;
        canvas.style.cursor = "grabbing";
        api.current.requestDraw();
        return;
      }
      const n = api.current.pick(p.x, p.y);
      const id = n?.id ?? null;
      canvas.style.cursor = n ? "pointer" : "grab";
      if (id !== s.hover) {
        s.hover = id;
        api.current.requestDraw();
      }
      if (n) {
        s.tipShown = true;
        setTip({ x: p.x, y: p.y, node: n });
      } else if (s.tipShown) {
        s.tipShown = false;
        setTip(null);
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = s.drag;
      if (!d) return;
      s.drag = null;
      canvas.releasePointerCapture(e.pointerId);
      s.sim?.alphaTarget(0);
      canvas.style.cursor = "pointer";
      if (d.moved) {
        api.current.savePositions(); // a dropped node stays where you put it
        return;
      }
      cb.current.onSelect(d.node.id); // a press without a drag is a click
    };
    const onClick = (e: MouseEvent) => {
      const p = local(e);
      if (!api.current.pick(p.x, p.y)) cb.current.onSelect(null);
    };
    const onDbl = (e: MouseEvent) => {
      const p = local(e);
      const n = api.current.pick(p.x, p.y);
      if (n) {
        n.fx = null; // double-click also releases a pinned node
        n.fy = null;
        api.current.zoomTo(n.id);
      } else api.current.zoomBy(1.6);
    };
    const onLeave = () => {
      s.hover = null;
      s.tipShown = false;
      setTip(null);
      api.current.requestDraw();
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("mouseleave", onLeave);
    (canvas as unknown as { __archon: unknown }).__archon = {
      state: s,
      draw: () => api.current.requestDraw(),
      zoomBy: (f: number) => api.current.zoomBy(f),
      zoomTo: (id: string) => api.current.zoomTo(id),
      // jump the camera without a glide (debugging / snapshots)
      jump: (id: string, k: number) => {
        const n = s.byId.get(id);
        if (!n) return;
        s.autoFit = false;
        const vw = s.w - (s.insetRight < s.w * 0.6 ? s.insetRight : 0);
        const t = zoomIdentity.translate(vw / 2 - (n.x ?? 0) * k, s.h / 2 - (n.y ?? 0) * k).scale(k);
        z.transform(sel, t);
        s.view = { k, x: t.x, y: t.y };
      },
    };

    cb.current.onReady?.({
      zoomTo: (id) => api.current.zoomTo(id),
      zoomToPath: (path) => api.current.fly(api.current.fitTransform(s.nodes.filter((n) => n.path === path || n.path.startsWith(`${path}/`)))),
      reset: () => api.current.fly(api.current.fitTransform(s.nodes)),
      upOneLevel: () => api.current.zoomBy(1 / 1.6),
      zoomBy: (f) => api.current.zoomBy(f),
      fitCurrent: () => api.current.fly(api.current.fitTransform(s.nodes)),
      preview: (id) => {
        s.preview = id;
        api.current.requestDraw();
      },
    });

    return () => {
      ro.disconnect();
      sel.on(".zoom", null);
      sel.interrupt();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("mouseleave", onLeave);
      s.sim?.stop();
      if (s.frame) {
        if (s.frameByTimer) clearTimeout(s.frame);
        else cancelAnimationFrame(s.frame);
        s.frame = 0;
      }
    };
  }, []);

  // ---- data -> simulation ------------------------------------------------------------------------------------
  useEffect(() => {
    const s = S.current;
    s.cacheKey = cacheKey;
    const prev = posCache.get(cacheKey);
    // keep positions of nodes we had (filters change, revisits), place new ones next to their container
    const old = new Map(s.settled ? s.nodes.map((n) => [n.id, n]) : []);
    const nodes = data.nodes.map((n) => {
      const o = old.get(n.id) ?? prev?.get(n.id);
      return { ...n, x: o?.x, y: o?.y, fx: o?.fx ?? null, fy: o?.fy ?? null } as GNode;
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    seedPositions(nodes);
    const links = data.links.map((l) => ({ ...l })) as L[];
    const nbrs = new Map<string, Set<string>>();
    for (const l of data.links) {
      const a = typeof l.source === "string" ? l.source : l.source.id;
      const b = typeof l.target === "string" ? l.target : l.target.id;
      if (!nbrs.has(a)) nbrs.set(a, new Set());
      if (!nbrs.has(b)) nbrs.set(b, new Set());
      nbrs.get(a)!.add(b);
      nbrs.get(b)!.add(a);
    }
    const degrees = nodes.map((n) => n.degree).sort((p, q) => q - p);
    s.hubCut = Math.max(4, degrees[Math.floor(degrees.length * 0.06)] ?? Infinity);
    s.sim?.stop();
    const sim = makeSimulation(nodes, links).alpha(0);
    // the worker settles the layout and streams positions back; a remembered layout only needs a nudge
    const alpha = prev || s.settled ? 0.3 : 1;
    const job = ++s.job;
    s.worker ??= new Worker(new URL("./force.worker.ts", import.meta.url), { type: "module" });
    s.worker.onmessage = (ev: MessageEvent<ForceResponse>) => {
      if (ev.data.id !== s.job) return;
      const xy = ev.data.xy;
      s.nodes.forEach((n, i) => {
        n.x = xy[i * 2];
        n.y = xy[i * 2 + 1];
      });
      // keep the whole graph in view while it settles (also if no frame ran in between, e.g. a busy tab)
      const canvas = canvasRef.current;
      const t = s.autoFit ? api.current.fitTransform(s.nodes) : null;
      if (t && canvas && s.zoom) {
        s.zoom.transform(select(canvas), t);
        s.anchor = null;
      }
      if (ev.data.done) {
        s.settling = false;
        s.settled = true;
        api.current.savePositions();
      }
      api.current.requestDraw();
    };
    const req: ForceRequest = {
      id: job,
      nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, r: n.r, x: n.x, y: n.y, fx: n.fx, fy: n.fy })),
      links: data.links.map((l) => ({
        source: typeof l.source === "string" ? l.source : l.source.id,
        target: typeof l.target === "string" ? l.target : l.target.id,
        kind: l.kind,
      })),
      alpha,
    };
    s.worker.postMessage(req);
    s.settling = true;
    s.sim = sim;
    s.nodes = nodes;
    s.links = links;
    s.byId = byId;
    s.nbrs = nbrs;
    if (!prev && !s.settled) s.autoFit = true;
    else if (!s.placed) {
      // coming back: place the camera on the remembered layout at once
      const t = api.current.fitTransform(nodes);
      const canvas = canvasRef.current;
      if (t && canvas && s.zoom) {
        s.zoom.transform(select(canvas), t);
        s.view = { k: t.k, x: t.x, y: t.y };
      }
    }
    s.placed = true;
    api.current.requestDraw();
    return () => {
      s.job++;
      s.worker?.terminate();
      s.worker = null;
      s.settling = false;
    };
  }, [data, cacheKey]);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden" style={{ background: MAP_BG }}>
      <canvas ref={canvasRef} className="block touch-none select-none" style={{ cursor: "grab" }} />
      {tip && (
        <div
          className="pointer-events-none absolute z-20 rounded-md border border-line px-2.5 py-1.5 text-[11px] shadow-xl"
          style={{ left: Math.min(tip.x + 14, (S.current.w || 400) - 300), top: tip.y + 16, maxWidth: 290, background: `${MAP_PANEL}f2` }}
        >
          <div className="flex items-baseline gap-2">
            <span className="mono text-fg break-all">{tip.node.full}</span>
            <span className="shrink-0" style={{ color: GRAPH_COLORS[tip.node.kind] }}>{GRAPH_KIND_LABEL[tip.node.kind] ?? tip.node.kind}</span>
          </div>
          {tip.node.path && <div className="text-faint truncate">{tip.node.path}</div>}
          <div className="text-muted">{tip.node.degree} relationships · drag to move · double-click to zoom in</div>
        </div>
      )}
    </div>
  );
}
