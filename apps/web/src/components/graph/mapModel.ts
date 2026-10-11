/**
 * The laid-out hierarchy the map renderer draws (decisions.md D-024, D-026, D-027).
 * Built from the view model (nesting) and the worker's rectangles (positions and sizes).
 */
import { KIND_STYLE, type NodeKind } from "@/lib/api";
import type { Positions } from "./layoutClient";
import type { ViewModel } from "./viewModel";

export const BG = "#0f1218";

/** Soft hues for top-level components; folders and files inside inherit their component's hue. */
const COMPONENT_HUES = ["#8fb8de", "#a8d5ba", "#c3b1e1", "#f0c7a2", "#e6a9b8", "#9fd3cf", "#b6c2e8", "#e3d6a0"];
/** Areas that are not code of their own (packages, loose files) stay neutral. */
export const NEUTRAL_HUE = "#b9b4a6";

export interface MapNode {
  id: string;
  parent?: string;
  kind: string;
  label: string;
  fullLabel: string;
  path: string;
  box: boolean;
  depth: number;
  children: string[];
  ancestors: string[]; // nearest first
  rect: { x: number; y: number; w: number; h: number; header?: number };
  hue: string; // component hue (boxes) or kind colour (leaves)
  area: string; // id of the top-level box this node belongs to
  neutral: boolean; // packages / loose-files area: drawn as a quiet neutral surface
  summary: string[]; // ranked parts: ["10 endpoints", "12 functions", "2 classes"]
  lines: number;
  isType: boolean;
  quiet: boolean;
  files: number; // files inside (boxes)
}

export interface MapEdge {
  source: string;
  target: string;
  kind: string;
  external: boolean;
}

export interface MapModel {
  nodes: Map<string, MapNode>;
  roots: string[];
  edges: MapEdge[];
  dominant: string | null; // a root that holds most of the code: opened at the overview
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : word.endsWith("s") ? "es" : "s"}`;

/** What a box holds, most informative first. Containers of folders/files lead with structure; files and
 *  classes lead with what they expose (endpoints, tables), then their symbols by count. */
function summarize(n: MapNode, nodes: Map<string, MapNode>): string[] {
  const c = { dir: 0, file: 0, cls: 0, type: 0, fn: 0, ep: 0, tbl: 0, dep: 0 };
  const walk = (m: MapNode) => {
    for (const id of m.children) {
      const k = nodes.get(id)!;
      if (k.kind === "directory") c.dir++;
      else if (k.kind === "file") c.file++;
      else if (k.kind === "class") {
        if (k.isType) c.type++;
        else c.cls++;
      }
      else if (k.kind === "function" || k.kind === "method") c.fn++;
      else if (k.kind === "endpoint") c.ep++;
      else if (k.kind === "table") c.tbl++;
      else if (k.kind === "dependency") c.dep++;
      walk(k);
    }
  };
  walk(n);
  if (c.dep) return [plural(c.dep, "package")];
  const exposes = [c.ep && plural(c.ep, "endpoint"), c.tbl && plural(c.tbl, "table")].filter(Boolean) as string[];
  const symbols = (
    [
      [c.cls, "class"],
      [c.type, "type"],
      [c.fn, "function"],
    ] as [number, string][]
  )
    .filter(([k]) => k > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([k, w]) => plural(k, w));
  if (c.dir || c.file) return [c.dir && plural(c.dir, "folder"), c.file && plural(c.file, "file"), ...exposes, ...symbols].filter(Boolean) as string[];
  return [...exposes, ...symbols];
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
      fullLabel: v.fullLabel,
      path: v.path,
      box: kids.has(v.id),
      depth: 0,
      children: kids.get(v.id) ?? [],
      ancestors: [],
      rect: r,
      hue: "",
      area: v.id,
      neutral: false,
      summary: [],
      lines: v.lines,
      isType: !!v.isType,
      quiet: !!v.quiet,
      files: 0,
    });
  }
  for (const n of nodes.values()) {
    for (let p = n.parent; p && nodes.has(p); p = nodes.get(p)!.parent) n.ancestors.push(p);
    n.depth = n.ancestors.length;
    n.area = n.ancestors.length ? n.ancestors[n.ancestors.length - 1] : n.id;
    if (n.kind === "file") for (const a of n.ancestors) nodes.get(a)!.files++;
  }
  const roots = [...nodes.values()].filter((n) => !n.parent || !nodes.has(n.parent)).map((n) => n.id);
  const isNeutralArea = (id: string) => {
    const k = nodes.get(id)!.kind;
    return k === "group" || k === "files";
  };
  // Hues by name, so an area keeps its colour across re-indexes and layout changes.
  const coded = roots.filter((r) => nodes.get(r)!.box && !isNeutralArea(r)).sort((a, b) => nodes.get(a)!.label.localeCompare(nodes.get(b)!.label));
  const hueOf = new Map(coded.map((id, i) => [id, COMPONENT_HUES[i % COMPONENT_HUES.length]]));
  for (const n of nodes.values()) {
    n.neutral = isNeutralArea(n.area);
    const kindColor = KIND_STYLE[n.kind as NodeKind]?.color ?? "#9aabc4";
    n.hue = n.box ? (n.neutral ? NEUTRAL_HUE : (hueOf.get(n.area) ?? kindColor)) : kindColor;
    if (n.box) n.summary = summarize(n, nodes);
  }
  // One root holding most of the code (e.g. a single `src`) would make the first zoom step reveal nothing:
  // the renderer opens it at the overview instead.
  const totalFiles = [...nodes.values()].filter((n) => n.kind === "file").length;
  const dominant =
    roots.length > 1
      ? (roots.find((r) => {
          const n = nodes.get(r)!;
          return n.box && !n.neutral && n.files >= Math.max(4, 0.7 * totalFiles) && n.children.length <= 12;
        }) ?? null)
      : null;
  return {
    nodes,
    roots,
    dominant,
    edges: view.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target)).map((e) => ({ source: e.source, target: e.target, kind: e.kind, external: e.external })),
  };
}
