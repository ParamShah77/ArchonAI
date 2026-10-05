/**
 * The laid-out hierarchy the map renderer draws (decisions.md D-024, D-025).
 * Built from the view model (nesting) and the worker's rectangles (positions and sizes).
 */
import { KIND_STYLE, type NodeKind } from "@/lib/api";
import type { Positions } from "./layoutClient";
import type { ViewModel } from "./viewModel";

export const BG = "#0f1218";

/** Soft hues for top-level components; folders and files inside inherit their component's hue. */
const COMPONENT_HUES = ["#8fb8de", "#a8d5ba", "#c3b1e1", "#f0c7a2", "#e6a9b8", "#9fd3cf", "#b6c2e8", "#e3d6a0"];

export interface MapNode {
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
  hue: string; // component hue (boxes) or kind colour (leaves)
  summary: string; // "10 folders · 64 files" for boxes
}

export interface MapEdge {
  source: string;
  target: string;
  kind: string;
}

export interface MapModel {
  nodes: Map<string, MapNode>;
  roots: string[];
  edges: MapEdge[];
}

/** Mix a colour into the background: solid, soft tints. */
export function tint(hex: string, amount: number, bg = BG): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [p(hex), p(bg)];
  return `#${a.map((v, i) => Math.round(b[i] + (v - b[i]) * amount).toString(16).padStart(2, "0")).join("")}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

function summarize(n: MapNode, nodes: Map<string, MapNode>): string {
  const counts: Record<string, number> = {};
  const walk = (m: MapNode) => {
    for (const c of m.children) {
      const k = nodes.get(c)!;
      counts[k.kind] = (counts[k.kind] ?? 0) + 1;
      walk(k);
    }
  };
  walk(n);
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
    .filter(([, c]) => c > 0)
    .slice(0, 2)
    .map(([w, c]) => `${c} ${w}${c === 1 ? "" : w === "class" ? "es" : "s"}`)
    .join(" · ");
}

export function buildMapModel(view: ViewModel, pos: Positions): MapModel {
  const nodes = new Map<string, MapNode>();
  const kids = new Map<string, string[]>();
  for (const v of view.nodes) {
    if (!v.parent) continue;
    if (!kids.has(v.parent)) kids.set(v.parent, []);
    kids.get(v.parent)!.push(v.id);
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
      hue: "",
      summary: "",
    });
  }
  for (const n of nodes.values()) {
    for (let p = n.parent; p && nodes.has(p); p = nodes.get(p)!.parent) n.ancestors.push(p);
    n.depth = n.ancestors.length;
  }
  const roots = [...nodes.values()].filter((n) => !n.parent || !nodes.has(n.parent)).map((n) => n.id);
  // biggest components get the first hues
  const byArea = [...roots].sort((a, b) => {
    const ra = nodes.get(a)!.rect;
    const rb = nodes.get(b)!.rect;
    return rb.w * rb.h - ra.w * ra.h;
  });
  const hueOf = new Map(byArea.map((id, i) => [id, COMPONENT_HUES[i % COMPONENT_HUES.length]]));
  for (const n of nodes.values()) {
    const root = n.ancestors.length ? n.ancestors[n.ancestors.length - 1] : n.id;
    const inPackages = nodes.get(root)?.kind === "group";
    const kindColor = KIND_STYLE[n.kind as NodeKind]?.color ?? "#9aabc4";
    n.hue = inPackages ? KIND_STYLE.dependency.color : n.box ? (hueOf.get(root) ?? kindColor) : kindColor;
    if (n.box) n.summary = summarize(n, nodes);
  }
  return { nodes, roots, edges: view.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)) };
}
