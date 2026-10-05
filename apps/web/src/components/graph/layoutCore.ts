/**
 * Pure layout computation (no DOM), used by the layout Web Worker (decisions.md D-022, D-023).
 *
 * Structure first, physics second:
 * 1. Every box (folder, file holding symbols, packages group) packs its children in tidy rows —
 *    sub-boxes first (largest first), then leaves in a stable order. Overlap is impossible by
 *    construction and the same repository always looks the same.
 * 2. Only the top-level items (boxes as solid blocks, loose nodes) are placed by fCoSE, using edges
 *    lifted to those items, so related parts of the system still sit near each other.
 * 3. A final pass pushes apart any top-level blocks that still touch.
 */
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
cytoscape.use(fcose as any);

export interface LayoutNode {
  id: string;
  parent?: string;
  w: number; // footprint: node + its label
  h: number;
  size: number; // drawn node diameter (the label hangs below it)
  sortKey: string;
}

export interface LayoutRequest {
  id: number;
  nodes: LayoutNode[];
  edges: [string, string][];
}

export interface LayoutResponse {
  id: number;
  positions?: Record<string, { x: number; y: number }>;
  error?: string;
  ms: number;
}

export const BOX_PADDING = 16; // must match the `:parent` padding in GraphCanvas
const LABEL_HEADER = 18; // room for a box title above its contents
const GAP_X = 14;
const GAP_Y = 10;
const ROOT_GAP = 40;
const ASPECT = 1.7; // preferred width/height of a packed box
const LABEL_SLOT = 18; // must match viewModel.LABEL_SLOT

interface Item {
  id: string;
  leaf?: LayoutNode;
  children: Item[];
  w: number;
  h: number;
  // centre relative to the parent's content origin (top-left), or absolute for root items
  x: number;
  y: number;
}

function pack(item: Item): void {
  if (item.leaf) {
    item.w = item.leaf.w;
    item.h = item.leaf.h;
    return;
  }
  for (const c of item.children) pack(c);
  const kids = [...item.children].sort((a, b) => {
    if (!!a.leaf !== !!b.leaf) return a.leaf ? 1 : -1; // boxes before loose leaves
    if (!a.leaf && !b.leaf) return b.h - a.h || b.w - a.w; // tallest first: rows of similar height waste less space
    return (a.leaf!.sortKey < b.leaf!.sortKey ? -1 : 1);
  });
  const area = kids.reduce((s, k) => s + (k.w + GAP_X) * (k.h + GAP_Y), 0);
  const maxW = Math.max(0, ...kids.map((k) => k.w));
  const target = Math.max(maxW, Math.sqrt(area * ASPECT));
  // shelf packing: fill a row up to the target width, then start the next row
  let x = 0, y = 0, rowH = 0, contentW = 0;
  for (const k of kids) {
    if (x > 0 && x + k.w > target) {
      y += rowH + GAP_Y;
      x = 0;
      rowH = 0;
    }
    k.x = x + k.w / 2;
    k.y = y + k.h / 2;
    x += k.w + GAP_X;
    rowH = Math.max(rowH, k.h);
    contentW = Math.max(contentW, x - GAP_X);
  }
  const contentH = y + rowH;
  // centre each row horizontally inside the box for a tidier look
  const rows = new Map<number, Item[]>();
  for (const k of kids) {
    const top = Math.round(k.y - k.h / 2);
    if (!rows.has(top)) rows.set(top, []);
    rows.get(top)!.push(k);
  }
  for (const row of rows.values()) {
    const right = Math.max(...row.map((k) => k.x + k.w / 2));
    const shift = (contentW - right) / 2;
    for (const k of row) k.x += shift;
  }
  item.children = kids;
  item.w = contentW + 2 * BOX_PADDING;
  item.h = contentH + 2 * BOX_PADDING + LABEL_HEADER;
}

function placeRoot(roots: Item[], rootOf: Map<string, string>, edges: [string, string][]): void {
  if (roots.length === 1) {
    roots[0].x = 0;
    roots[0].y = 0;
    return;
  }
  // edges between descendants become weighted edges between their top-level items
  const lifted = new Map<string, number>();
  for (const [s, t] of edges) {
    const a = rootOf.get(s), b = rootOf.get(t);
    if (!a || !b || a === b) continue;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    lifted.set(k, (lifted.get(k) ?? 0) + 1);
  }
  if (lifted.size === 0) {
    // nothing connects them: a tidy grid of blocks
    const box: Item = { id: "__root__", children: roots, w: 0, h: 0, x: 0, y: 0 };
    pack(box);
    for (const r of roots) {
      r.x -= box.w / 2;
      r.y -= box.h / 2;
    }
    return;
  }
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    style: [{ selector: "node", style: { width: "data(w)", height: "data(h)", shape: "rectangle" } }],
  });
  cy.add([
    ...roots.map((r) => ({ group: "nodes" as const, data: { id: r.id, w: r.w + ROOT_GAP, h: r.h + ROOT_GAP } })),
    ...[...lifted.entries()].map(([k, w], i) => {
      const [s, t] = k.split("|");
      return { group: "edges" as const, data: { id: `l${i}`, source: s, target: t, w } };
    }),
  ]);
  cy.layout({
    name: "fcose",
    animate: false,
    randomize: true,
    quality: "default",
    uniformNodeDimensions: false,
    packComponents: true,
    nodeSeparation: ROOT_GAP,
    nodeRepulsion: () => 6000,
    idealEdgeLength: (e: { data: (k: string) => number }) => Math.max(40, 120 - 6 * e.data("w")),
    edgeElasticity: () => 0.3,
    gravity: 0.4,
    numIter: 2500,
    tile: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any).run();
  const byId = new Map(roots.map((r) => [r.id, r]));
  cy.nodes().forEach((n) => {
    const r = byId.get(n.id())!;
    r.x = n.position().x;
    r.y = n.position().y;
  });
  cy.destroy();
  separateRigid(roots);
}

/** Push apart top-level blocks that still overlap (each moves as a solid unit). */
function separateRigid(items: Item[]): void {
  for (let iter = 0; iter < 200; iter++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const ox = (a.w + b.w) / 2 + ROOT_GAP / 2 - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + ROOT_GAP / 2 - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const s = (a.x <= b.x ? -1 : 1) * (ox / 2);
          a.x += s;
          b.x -= s;
        } else {
          const s = (a.y <= b.y ? -1 : 1) * (oy / 2);
          a.y += s;
          b.y -= s;
        }
      }
    }
    if (!moved) break;
  }
}

/** Turn relative child centres into absolute leaf positions. */
function emit(item: Item, cx: number, cy: number, out: Record<string, { x: number; y: number }>): void {
  if (item.leaf) {
    // the footprint is a node slot plus a label slot underneath: centre the node in its slot, so every
    // node in a row shares one centre line whatever its size
    out[item.id] = { x: cx, y: cy - item.h / 2 + (item.h - LABEL_SLOT) / 2 };
    return;
  }
  const ox = cx - item.w / 2 + BOX_PADDING;
  const oy = cy - item.h / 2 + BOX_PADDING + LABEL_HEADER;
  for (const c of item.children) emit(c, ox + c.x, oy + c.y, out);
}

export function runLayout(nodes: LayoutNode[], edges: [string, string][]): Record<string, { x: number; y: number }> {
  const items = new Map<string, Item>();
  for (const n of nodes) items.set(n.id, { id: n.id, children: [], w: 0, h: 0, x: 0, y: 0 });
  const hasChildren = new Set<string>();
  for (const n of nodes) if (n.parent && items.has(n.parent)) hasChildren.add(n.parent);
  for (const n of nodes) {
    const it = items.get(n.id)!;
    if (!hasChildren.has(n.id)) it.leaf = n;
  }
  const roots: Item[] = [];
  for (const n of nodes) {
    const it = items.get(n.id)!;
    if (n.parent && items.has(n.parent)) items.get(n.parent)!.children.push(it);
    else roots.push(it);
  }
  // a box with no children left (e.g. an empty folder) is drawn as a plain leaf
  for (const r of roots) pack(r);
  const rootOf = new Map<string, string>();
  const mark = (it: Item, root: string) => {
    rootOf.set(it.id, root);
    for (const c of it.children) mark(c, root);
  };
  for (const r of roots) mark(r, r.id);
  placeRoot(roots, rootOf, edges);
  const out: Record<string, { x: number; y: number }> = {};
  for (const r of roots) emit(r, r.x, r.y, out);
  return out;
}
