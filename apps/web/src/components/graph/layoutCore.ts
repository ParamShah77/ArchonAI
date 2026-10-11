/**
 * Pure layout computation (no DOM), used by the layout Web Worker (decisions.md D-022, D-023, D-027).
 *
 * Every box (folder, file holding symbols, packages group) and the top level itself pack their children
 * in tidy rows: sub-boxes first (tallest first), then leaves in a stable order. Overlap is impossible by
 * construction and the same repository always looks the same.
 *
 * Row width is chosen per box by trying a range of widths and scoring each result for (a) how close the
 * finished box is to the screen's shape and (b) how little of it is empty, so a box you fly into fills the
 * screen instead of standing as a tall narrow column.
 */

export interface LayoutNode {
  id: string;
  parent?: string;
  w: number; // footprint
  h: number;
  size: number;
  sortKey: string;
}

export interface LayoutRequest {
  id: number;
  nodes: LayoutNode[];
  edges: [string, string][];
}

export interface LayoutResponse {
  id: number;
  positions?: Record<string, Rect>;
  error?: string;
  ms: number;
}

export const BOX_PADDING = 16;
const GAP_X = 14;
const GAP_Y = 10;
const ROOT_GAP = 40;
// Geometric mean of the map's shape with the details panel open (≈1.34) and closed (≈1.86).
const TARGET_ASPECT = 1.55;
const TRIES = 24;

/** Title band at the top of a box; grows with the box so its title stays legible when zoomed out. */
export function headerFor(w: number): number {
  return Math.max(20, w / 22);
}

export interface Rect {
  x: number; // centre
  y: number;
  w: number;
  h: number;
  header?: number; // boxes only
}

interface Item {
  id: string;
  header?: number;
  leaf?: LayoutNode;
  children: Item[];
  w: number;
  h: number;
  // centre relative to the parent's content origin (top-left), or absolute for root items
  x: number;
  y: number;
}

interface Shelf {
  w: number;
  h: number;
  cols: number; // most items in one row
  place: { x: number; y: number }[]; // centres, same order as the input
}

/** Shelf packing: fill a row up to `target` width, then start the next; rows centred horizontally. */
function shelf(kids: Item[], target: number, gx: number, gy: number): Shelf {
  const place: { x: number; y: number }[] = [];
  const rows: { right: number; items: number[] }[] = [];
  let x = 0, y = 0, rowH = 0, contentW = 0;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (x > 0 && x + k.w > target) {
      y += rowH + gy;
      x = 0;
      rowH = 0;
    }
    if (x === 0) rows.push({ right: 0, items: [] });
    const row = rows[rows.length - 1];
    place.push({ x: x + k.w / 2, y: y + k.h / 2 });
    row.items.push(i);
    x += k.w + gx;
    row.right = x - gx;
    rowH = Math.max(rowH, k.h);
    contentW = Math.max(contentW, x - gx);
  }
  for (const row of rows) {
    const shift = (contentW - row.right) / 2;
    for (const i of row.items) place[i].x += shift;
  }
  return { w: contentW, h: y + rowH, cols: Math.max(0, ...rows.map((r) => r.items.length)), place };
}

/** Pick the row width whose finished box best matches the screen's shape with the least empty space. */
function bestShelf(kids: Item[], gx: number, gy: number, withHeader: boolean): Shelf {
  const area = kids.reduce((s, k) => s + (k.w + gx) * (k.h + gy), 0);
  const filled = kids.reduce((s, k) => s + k.w * k.h, 0);
  const maxW = Math.max(0, ...kids.map((k) => k.w));
  const leaves = kids.filter((k) => k.leaf).length;
  let best: { s: Shelf; score: number } | null = null;
  let bestMulti: { s: Shelf; score: number } | null = null;
  let lastW = -1;
  for (let i = 0; i < TRIES; i++) {
    const target = Math.max(maxW, Math.sqrt(area * 0.4 * Math.pow(1.15, i)));
    if (target === lastW) continue;
    lastW = target;
    const s = shelf(kids, target, gx, gy);
    const boxW = s.w + 2 * BOX_PADDING;
    const boxH = s.h + 2 * BOX_PADDING + (withHeader ? headerFor(boxW) : 0);
    const fill = filled / Math.max(1, s.w * s.h);
    const score = Math.abs(Math.log(boxW / boxH / TARGET_ASPECT)) + 0.8 * (1 - fill);
    if (!best || score < best.score) best = { s, score };
    if (s.cols >= 2 && (!bestMulti || score < bestMulti.score)) bestMulti = { s, score };
  }
  // a single column of four or more leaves reads badly (a tall strip of methods): prefer two or more
  // columns when that is nearly as good
  if (best && best.s.cols === 1 && leaves >= 4 && bestMulti && bestMulti.score <= best.score + 0.15) return bestMulti.s;
  return best!.s;
}

function sortKids(item: Item): Item[] {
  return [...item.children].sort((a, b) => {
    if (!!a.leaf !== !!b.leaf) return a.leaf ? 1 : -1; // boxes before loose leaves
    if (!a.leaf && !b.leaf) return b.h - a.h || b.w - a.w || (a.id < b.id ? -1 : 1); // tallest first
    return a.leaf!.sortKey < b.leaf!.sortKey ? -1 : a.leaf!.sortKey > b.leaf!.sortKey ? 1 : 0;
  });
}

function pack(item: Item): void {
  if (item.leaf) {
    item.w = item.leaf.w;
    item.h = item.leaf.h;
    return;
  }
  for (const c of item.children) pack(c);
  const kids = sortKids(item);
  const s = bestShelf(kids, GAP_X, GAP_Y, true);
  kids.forEach((k, i) => {
    k.x = s.place[i].x;
    k.y = s.place[i].y;
  });
  item.children = kids;
  item.w = s.w + 2 * BOX_PADDING;
  item.header = headerFor(item.w);
  item.h = s.h + 2 * BOX_PADDING + item.header;
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
  const kids = sortKids({ id: "__root__", children: roots, w: 0, h: 0, x: 0, y: 0 });
  const s = bestShelf(kids, gap, gap, false);
  kids.forEach((k, i) => {
    k.x = s.place[i].x - s.w / 2;
    k.y = s.place[i].y - s.h / 2;
  });
}

/** Turn relative child centres into absolute rectangles for every leaf and box. */
function emit(item: Item, cx: number, cy: number, out: Record<string, Rect>): void {
  if (item.leaf) {
    out[item.id] = { x: cx, y: cy, w: item.w, h: item.h }; // the chip is centred in its footprint
    return;
  }
  out[item.id] = { x: cx, y: cy, w: item.w, h: item.h, header: item.header };
  const ox = cx - item.w / 2 + BOX_PADDING;
  const oy = cy - item.h / 2 + BOX_PADDING + (item.header ?? 0);
  for (const c of item.children) emit(c, ox + c.x, oy + c.y, out);
}

// `edges` is part of the request for future relationship-aware ordering; packing does not need it yet.
export function runLayout(nodes: LayoutNode[], _edges: [string, string][]): Record<string, Rect> {
  void _edges;
  const items = new Map<string, Item>();
  for (const n of nodes) items.set(n.id, { id: n.id, children: [], w: 0, h: 0, x: 0, y: 0 });
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
  for (const r of roots) pack(r);
  placeRoots(roots);
  const out: Record<string, Rect> = {};
  for (const r of roots) emit(r, r.x, r.y, out);
  return out;
}
