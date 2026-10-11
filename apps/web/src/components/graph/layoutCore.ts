/**
 * Pure layout computation (no DOM), used by the layout Web Worker (decisions.md D-022, D-023, D-027, D-029).
 *
 * Every box (folder, file holding symbols, packages group) and the top level pack their children:
 * - boxes holding sub-boxes: rows (tallest first), row width chosen so the finished box matches the screen's
 *   shape with little empty space; tiles in a row share top and bottom edges, and nearly-full rows fill out;
 * - symbol lists with internal calls: call-flow layers, so callers sit above what they call (entry points
 *   on top, helpers below, crossings reduced by barycenter sweeps);
 * - other symbol lists: left-aligned columns.
 * Gaps and padding scale with the box, so big tiles do not touch and small boxes do not waste space.
 */

export interface LayoutNode {
  id: string;
  parent?: string;
  w: number; // footprint
  h: number;
  size: number;
  sortKey: string;
  kind?: string;
  priv?: boolean;
  tier?: number; // 0 product code, 1 tests, 2 groups (Packages, Other files): later tiers come last
  path?: string;
}

export type LayoutEdge = [string, string, string]; // source, target, kind

export interface LayoutRequest {
  id: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

export interface LayoutResponse {
  id: number;
  positions?: Record<string, Rect>;
  error?: string;
  ms: number;
}

const ROOT_GAP = 40;
// Geometric mean of the map's shape with the details panel open (≈1.34) and closed (≈1.86).
const TARGET_ASPECT = 1.55;
const TRIES = 24;
const LEAF_GAP_X = 14;
const LEAF_GAP_Y_GRID = 6; // + the 30-unit footprint: compact lists
const LEAF_GAP_Y_FLOW = 22; // room for call lines between layers
const FLOW_KINDS = new Set(["calls", "extends", "implements", "exposes"]);

/** Title band at the top of a box; grows with the box so its title stays legible when zoomed out. */
export function headerFor(w: number): number {
  return Math.max(14, w / 28);
}

const paddingFor = (contentW: number) => Math.max(10, 0.02 * contentW);

export interface Rect {
  x: number; // centre
  y: number;
  w: number;
  h: number;
  header?: number; // boxes only
  pad?: number; // boxes only
}

interface Item {
  id: string;
  node?: LayoutNode;
  rank?: number; // dependency order among box siblings (users before what they use)
  header?: number;
  pad?: number;
  leaf?: LayoutNode;
  children: Item[];
  w: number;
  h: number;
  // centre relative to the parent's content origin (top-left), or absolute for root items
  x: number;
  y: number;
}

interface Placed {
  w: number;
  h: number;
  cols: number; // most items in one row / columns in a grid
  place: { x: number; y: number }[]; // centres, same order as the input
  rows: number[][]; // indices per row (for row equalisation)
}

const boxDims = (s: Placed, withHeader: boolean) => {
  const pad = paddingFor(s.w);
  const w = s.w + 2 * pad;
  return { w, h: s.h + 2 * pad + (withHeader ? headerFor(w) : 0) };
};

const score = (s: Placed, filled: number, withHeader: boolean) => {
  const { w, h } = boxDims(s, withHeader);
  const fill = filled / Math.max(1, s.w * s.h);
  return Math.abs(Math.log(w / h / TARGET_ASPECT)) + 0.8 * (1 - fill);
};

/** Shelf packing: fill a row up to `target` width, then start the next; rows centred. `breaks` marks indices
 *  that begin a new group (call-flow layer): a group starts a new row once the current row is 40% full. */
function shelf(kids: Item[], target: number, gx: number, gy: number, breaks?: Set<number>, center = true): Placed {
  const place: { x: number; y: number }[] = [];
  const rows: number[][] = [];
  const rowRight: number[] = [];
  let x = 0, y = 0, rowH = 0, contentW = 0;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    const groupBreak = breaks?.has(i) && x > 0 && x >= 0.4 * target;
    if (x > 0 && (x + k.w > target || groupBreak)) {
      y += rowH + gy;
      x = 0;
      rowH = 0;
    } else if (breaks?.has(i) && x > 0) x += gx; // a small layer shares the row, a little apart
    if (x === 0) {
      rows.push([]);
      rowRight.push(0);
    }
    place.push({ x: x + k.w / 2, y: y + k.h / 2 });
    rows[rows.length - 1].push(i);
    x += k.w + gx;
    rowRight[rowRight.length - 1] = x - gx;
    rowH = Math.max(rowH, k.h);
    contentW = Math.max(contentW, x - gx);
  }
  if (center) {
    rows.forEach((row, r) => {
      const shift = (contentW - rowRight[r]) / 2;
      for (const i of row) place[i].x += shift;
    });
  }
  return { w: contentW, h: y + rowH, cols: Math.max(0, ...rows.map((r) => r.length)), place, rows };
}

/** Pick the row width whose finished box best matches the screen's shape with the least empty space. */
function bestShelf(kids: Item[], gx: number, gy: number, withHeader: boolean, breaks?: Set<number>, center = true): Placed {
  const area = kids.reduce((s, k) => s + (k.w + gx) * (k.h + gy), 0);
  const filled = kids.reduce((s, k) => s + k.w * k.h, 0);
  const maxW = Math.max(0, ...kids.map((k) => k.w));
  const leaves = kids.filter((k) => k.leaf).length;
  let best: { s: Placed; score: number } | null = null;
  let bestMulti: { s: Placed; score: number } | null = null;
  let lastW = -1;
  for (let i = 0; i < TRIES; i++) {
    const target = Math.max(maxW, Math.sqrt(area * 0.4 * Math.pow(1.15, i)));
    if (target === lastW) continue;
    lastW = target;
    const s = shelf(kids, target, gx, gy, breaks, center);
    const sc = score(s, filled, withHeader);
    if (!best || sc < best.score) best = { s, score: sc };
    if (s.cols >= 2 && (!bestMulti || sc < bestMulti.score)) bestMulti = { s, score: sc };
  }
  // a single column of four or more leaves reads badly (a tall strip of methods): prefer two or more
  // columns when that is nearly as good
  if (best && best.s.cols === 1 && leaves >= 4 && bestMulti && bestMulti.score <= best.score + 0.15) return bestMulti.s;
  return best!.s;
}

/** Symbols without internal relationships: tidy left-aligned columns (column-major, reading order). */
function bestGrid(kids: Item[], gx: number, gy: number): Placed {
  const n = kids.length;
  const colW = Math.max(0, ...kids.map((k) => k.w));
  const rowH = Math.max(0, ...kids.map((k) => k.h));
  const filled = kids.reduce((s, k) => s + k.w * k.h, 0);
  let best: { s: Placed; score: number } | null = null;
  let bestMulti: { s: Placed; score: number } | null = null;
  for (let cols = 1; cols <= Math.min(n, 12); cols++) {
    const rows = Math.ceil(n / cols);
    if (cols > 1 && Math.ceil(n / (cols - 1)) === rows) continue; // same shape as fewer columns
    const place = kids.map((k, i) => {
      const c = Math.floor(i / rows);
      const r = i % rows;
      return { x: c * (colW + gx) + k.w / 2, y: r * (rowH + gy) + rowH / 2 };
    });
    const usedCols = Math.ceil(n / rows);
    const s: Placed = {
      w: usedCols * colW + (usedCols - 1) * gx,
      h: rows * rowH + (rows - 1) * gy,
      cols: usedCols,
      place,
      rows: Array.from({ length: rows }, (_, r) => kids.map((_k, i) => i).filter((i) => i % rows === r)),
    };
    const sc = score(s, filled, true);
    if (!best || sc < best.score) best = { s, score: sc };
    if (usedCols >= 2 && (!bestMulti || sc < bestMulti.score)) bestMulti = { s, score: sc };
  }
  if (best && best.s.cols === 1 && n >= 4 && bestMulti && bestMulti.score <= best.score + 0.15) return bestMulti.s;
  return best!.s;
}

/** Call-flow layers for the symbols of one box: callers above callees (longest path from entry points),
 *  endpoints and tables on top, cycles broken deterministically, order within a layer by barycenter, public
 *  before private. Returns the items in layer order and the indices where each layer starts. */
function layerLeaves(kids: Item[], edges: LayoutEdge[]): { order: Item[]; breaks: Set<number> } {
  const byId = new Map(kids.map((k) => [k.id, k]));
  const ids = [...kids].sort((a, b) => (a.leaf!.sortKey < b.leaf!.sortKey ? -1 : 1)).map((k) => k.id);
  const rank = new Map(ids.map((id, i) => [id, i]));
  const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const [s0, t0, kind] of edges) {
    let s = s0, t = t0;
    // an endpoint exposes its handler: draw the endpoint above it
    if (kind === "exposes" && byId.get(t)?.leaf?.kind === "endpoint") [s, t] = [t, s];
    if (s !== t && out.has(s) && out.has(t)) out.get(s)!.add(t);
  }
  // break cycles: depth-first in name order, dropping edges back to a node on the stack
  const state = new Map<string, number>(); // 1 = on stack, 2 = done
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const visit = (u: string) => {
    state.set(u, 1);
    for (const v of [...out.get(u)!].sort((a, b) => rank.get(a)! - rank.get(b)!)) {
      if (state.get(v) === 1) continue;
      dag.get(u)!.push(v);
      if (!state.has(v)) visit(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [u, vs] of dag) for (const v of vs) preds.get(v)!.push(u);
  const connected = new Set<string>();
  for (const [u, vs] of dag) if (vs.length) [u, ...vs].forEach((x) => connected.add(x));
  // longest-path layers (callers first)
  const layer = new Map<string, number>();
  const depth = (v: string): number => {
    const known = layer.get(v);
    if (known !== undefined) return known;
    const kind = byId.get(v)!.leaf!.kind;
    const d = kind === "endpoint" || kind === "table" ? 0 : Math.max(0, ...preds.get(v)!.map((u) => depth(u) + 1));
    layer.set(v, d);
    return d;
  };
  for (const id of ids) if (connected.has(id)) depth(id);
  const nLayers = Math.max(0, ...[...layer.values()].map((d) => d + 1));
  const layers: string[][] = Array.from({ length: nLayers }, () => []);
  for (const id of ids) if (connected.has(id)) layers[layer.get(id)!].push(id);
  // barycenter sweeps (down, up, down, up); public before private within a layer
  const pos = new Map<string, number>();
  const setPos = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  const priv = (id: string) => (byId.get(id)!.leaf!.priv ? 1 : 0);
  setPos();
  for (let sweep = 0; sweep < 4; sweep++) {
    const down = sweep % 2 === 0;
    const range = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse();
    for (const i of range) {
      const bary = new Map<string, number>();
      for (const id of layers[i]) {
        const nb = down ? preds.get(id)! : dag.get(id)!;
        const ps = nb.map((x) => pos.get(x)).filter((p): p is number => p !== undefined);
        bary.set(id, ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : pos.get(id)!);
      }
      layers[i].sort((a, b) => priv(a) - priv(b) || bary.get(a)! - bary.get(b)! || rank.get(a)! - rank.get(b)!);
      setPos();
    }
  }
  const loose = ids.filter((id) => !connected.has(id));
  const groups = [...layers, ...(loose.length ? [loose] : [])];
  const order: Item[] = [];
  const breaks = new Set<number>();
  for (const g of groups) {
    breaks.add(order.length);
    for (const id of g) order.push(byId.get(id)!);
  }
  breaks.delete(0);
  return { order, breaks };
}

const tierOf = (i: Item) => i.node?.tier ?? 0;
const sizeBucket = (i: Item) => Math.floor(Math.log2(Math.max(1, i.w * i.h)));
const pathOf = (i: Item) => i.node?.path ?? i.id;

/** Order inside a box: boxes before loose leaves; product code before tests before groups; then files that
 *  use things before the things they use; then bigger before smaller (by size bucket); then by path. */
function sortKids(item: Item): Item[] {
  return [...item.children].sort((a, b) => {
    if (!!a.leaf !== !!b.leaf) return a.leaf ? 1 : -1;
    if (!a.leaf && !b.leaf) {
      return (
        tierOf(a) - tierOf(b) ||
        (a.rank ?? 0) - (b.rank ?? 0) ||
        sizeBucket(b) - sizeBucket(a) ||
        (pathOf(a) < pathOf(b) ? -1 : pathOf(a) > pathOf(b) ? 1 : 0)
      );
    }
    return tierOf(a) - tierOf(b) || (a.leaf!.sortKey < b.leaf!.sortKey ? -1 : a.leaf!.sortKey > b.leaf!.sortKey ? 1 : 0);
  });
}

/** Dependency rank of a box's child boxes from the relationships between them (lifted to those children):
 *  longest path from the ones nothing uses, cycles broken in path order. */
function rankChildren(item: Item, sib: [string, string][]) {
  const boxes = item.children.filter((c) => !c.leaf);
  if (boxes.length < 2 || !sib.length) return;
  const ids = [...boxes].sort((a, b) => (pathOf(a) < pathOf(b) ? -1 : 1)).map((b) => b.id);
  const out = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const [a, b] of sib) if (out.has(a) && out.has(b) && a !== b) out.get(a)!.add(b);
  const state = new Map<string, number>();
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const visit = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) continue;
      dag.get(u)!.push(v);
      if (!state.has(v)) visit(v);
    }
    state.set(u, 2);
  };
  for (const id of ids) if (!state.has(id)) visit(id);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [u, vs] of dag) for (const v of vs) preds.get(v)!.push(u);
  const rank = new Map<string, number>();
  const depth = (v: string): number => {
    const r = rank.get(v);
    if (r !== undefined) return r;
    const d = Math.max(0, ...preds.get(v)!.map((u) => depth(u) + 1));
    rank.set(v, d);
    return d;
  };
  for (const b of boxes) b.rank = depth(b.id);
}

/** Tiles in a row share top and bottom edges (if similar in height); a nearly full row fills out. */
function equaliseRows(kids: Item[], s: Placed, gx: number) {
  for (const row of s.rows) {
    if (row.length < 2 || row.some((i) => kids[i].leaf)) continue;
    const hs = row.map((i) => kids[i].h);
    const maxH = Math.max(...hs);
    const top = Math.min(...row.map((i) => s.place[i].y - kids[i].h / 2));
    if (maxH / Math.min(...hs) <= 1.5) {
      for (const i of row) {
        kids[i].h = maxH;
        s.place[i].y = top + maxH / 2;
      }
    }
    const used = row.reduce((sum, i) => sum + kids[i].w, 0) + gx * (row.length - 1);
    const free = s.w - used;
    if (free > 0 && free / s.w <= 0.3) {
      let x = 0;
      for (const i of row) {
        const k = kids[i];
        const dw = (free * k.w) / (used - gx * (row.length - 1));
        for (const c of k.children) c.x += dw / 2; // keep its contents centred
        k.w += dw;
        s.place[i].x = x + k.w / 2;
        x += k.w + gx;
      }
    }
  }
}

function pack(item: Item, edgesByBox: Map<string, LayoutEdge[]>, sibByBox: Map<string, [string, string][]>): void {
  if (item.leaf) {
    item.w = item.leaf.w;
    item.h = item.leaf.h;
    return;
  }
  for (const c of item.children) pack(c, edgesByBox, sibByBox);
  rankChildren(item, sibByBox.get(item.id) ?? []);
  let kids = sortKids(item);
  let s: Placed;
  if (kids.every((k) => k.leaf)) {
    const inner = edgesByBox.get(item.id) ?? [];
    if (inner.length >= 3) {
      const { order, breaks } = layerLeaves(kids, inner);
      kids = order;
      s = bestShelf(kids, LEAF_GAP_X, LEAF_GAP_Y_FLOW, true, breaks);
    } else {
      s = bestGrid(kids, LEAF_GAP_X, LEAF_GAP_Y_GRID);
    }
  } else {
    // gaps scale with the tiles, so big tiles do not touch and small ones do not drift apart
    const sides = kids.filter((k) => !k.leaf).map((k) => Math.min(k.w, k.h)).sort((a, b) => a - b);
    const gap = Math.min(80, Math.max(14, 0.06 * sides[Math.floor(sides.length / 2)]));
    // a file with classes and loose functions: the classes first, then the functions in call-flow layers
    const boxKids = kids.filter((k) => !k.leaf);
    const leafKids = kids.filter((k) => k.leaf);
    const inner = edgesByBox.get(item.id) ?? [];
    let breaks: Set<number> | undefined;
    if (leafKids.length >= 3 && inner.length >= 3) {
      const lay = layerLeaves(leafKids, inner);
      kids = [...boxKids, ...lay.order];
      breaks = new Set([boxKids.length, ...[...lay.breaks].map((i) => i + boxKids.length)]);
    }
    s = bestShelf(kids, gap, gap, true, breaks);
    equaliseRows(kids, s, gap);
  }
  kids.forEach((k, i) => {
    k.x = s.place[i].x;
    k.y = s.place[i].y;
  });
  item.children = kids;
  item.pad = paddingFor(s.w);
  item.w = s.w + 2 * item.pad;
  item.header = headerFor(item.w);
  item.h = s.h + 2 * item.pad + item.header;
}

/** Top-level blocks: same packing, with a gap that scales with the map so blocks read as separate when
 *  zoomed all the way out. Centred on the origin. */
function placeRoots(roots: Item[]): void {
  if (roots.length === 1) {
    roots[0].x = 0;
    roots[0].y = 0;
    return;
  }
  const gap = Math.max(ROOT_GAP, 0.07 * Math.sqrt(roots.reduce((s, r) => s + r.w * r.h, 0)));
  // product code first (biggest first), then tests, then Packages / loose files
  const kids = [...roots].sort((a, b) => tierOf(a) - tierOf(b) || b.w * b.h - a.w * a.h || (pathOf(a) < pathOf(b) ? -1 : 1));
  const s = bestShelf(kids, gap, gap, false);
  kids.forEach((k, i) => {
    k.x = s.place[i].x - s.w / 2;
    k.y = s.place[i].y - s.h / 2;
  });
}

/** Turn relative child centres into absolute rectangles for every leaf and box. */
function emit(item: Item, cx: number, cy: number, out: Record<string, Rect>): void {
  if (item.leaf) {
    out[item.id] = { x: cx, y: cy, w: item.w, h: item.h };
    return;
  }
  const pad = item.pad ?? 10;
  out[item.id] = { x: cx, y: cy, w: item.w, h: item.h, header: item.header, pad };
  const ox = cx - item.w / 2 + pad;
  const oy = cy - item.h / 2 + pad + (item.header ?? 0);
  for (const c of item.children) emit(c, ox + c.x, oy + c.y, out);
}

export function runLayout(nodes: LayoutNode[], edges: LayoutEdge[]): Record<string, Rect> {
  const items = new Map<string, Item>();
  for (const n of nodes) items.set(n.id, { id: n.id, node: n, children: [], w: 0, h: 0, x: 0, y: 0 });
  const hasChildren = new Set<string>();
  for (const n of nodes) if (n.parent && items.has(n.parent)) hasChildren.add(n.parent);
  for (const n of nodes) {
    const it = items.get(n.id)!;
    if (!hasChildren.has(n.id)) it.leaf = n; // a box with no children left is drawn as a plain leaf
  }
  const roots: Item[] = [];
  for (const n of nodes) {
    const it = items.get(n.id)!;
    if (n.parent && items.has(n.parent)) items.get(n.parent)!.children.push(it);
    else roots.push(it);
  }
  // relationships between symbols of the same box drive the call-flow layers
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent]));
  const edgesByBox = new Map<string, LayoutEdge[]>();
  for (const e of edges) {
    if (!FLOW_KINDS.has(e[2])) continue;
    const p = parentOf.get(e[0]);
    if (!p || p !== parentOf.get(e[1])) continue;
    if (!edgesByBox.has(p)) edgesByBox.set(p, []);
    edgesByBox.get(p)!.push(e);
  }
  // relationships between parts of a box, lifted to its direct children: drives "users before used"
  const chain = (id: string) => {
    const out: string[] = [];
    for (let cur: string | undefined = id; cur; cur = parentOf.get(cur)) out.push(cur);
    return out; // the node, then its ancestors up to the root
  };
  const sibByBox = new Map<string, [string, string][]>();
  for (const [s0, t0] of edges) {
    const a = chain(s0);
    const b = chain(t0);
    const inB = new Set(b);
    const lcaIdx = a.findIndex((x) => inB.has(x));
    if (lcaIdx <= 0) continue; // no common box, or one contains the other
    const lca = a[lcaIdx];
    const ca = a[lcaIdx - 1];
    const cb = b[b.indexOf(lca) - 1];
    if (!cb || ca === cb) continue;
    if (!sibByBox.has(lca)) sibByBox.set(lca, []);
    sibByBox.get(lca)!.push([ca, cb]);
  }
  for (const r of roots) pack(r, edgesByBox, sibByBox);
  placeRoots(roots);
  const out: Record<string, Rect> = {};
  for (const r of roots) emit(r, r.x, r.y, out);
  return out;
}
