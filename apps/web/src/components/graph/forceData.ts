/**
 * Data for the Graph view: a Neo4j-style node-link graph of the code (decisions.md D-032).
 * Every node is a circle coloured by kind; every relationship (including "contains") is a labelled line,
 * so files form star clusters with their symbols and folders hold the clusters together.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation } from "d3-force";
import type { Graph } from "@/lib/api";

/** Neo4j-like palette: clear, friendly colours that stay distinct on the dark map. */
export const GRAPH_COLORS: Record<string, string> = {
  directory: "#FFC454",
  file: "#F79767",
  class: "#C990C0",
  function: "#57C7E3",
  method: "#8DCC93",
  endpoint: "#ECB5C9",
  table: "#F16667",
  dependency: "#D9C8AE",
  module: "#F79767",
};
export const GRAPH_KIND_LABEL: Record<string, string> = {
  directory: "Folder",
  file: "File",
  class: "Class",
  function: "Function",
  method: "Method",
  endpoint: "Endpoint",
  table: "Table",
  dependency: "Package",
  module: "Module",
};
export const KIND_ORDER = ["directory", "file", "class", "function", "method", "endpoint", "table", "dependency"];

export interface GNode {
  id: string;
  kind: string;
  label: string; // shown inside / beside the circle
  full: string; // tooltip name
  path: string;
  r: number; // radius in world units
  degree: number;
  parent?: string; // containing node (for seeding positions)
  // simulation state (d3-force)
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  index?: number;
}

export interface GLink {
  source: string | GNode;
  target: string | GNode;
  kind: string; // CONTAINS, CALLS, …
}

export interface GraphData {
  nodes: GNode[];
  links: GLink[];
  kindCounts: Map<string, number>; // before filtering
  relCounts: Map<string, number>;
}

export const relLabel = (kind: string) => kind.toUpperCase();

export function buildGraphData(g: Graph, hiddenKinds: Set<string>, hiddenRels: Set<string>): GraphData {
  const all = g.nodes.filter((n) => n.kind !== "repo");
  const byId = new Map(all.map((n) => [n.id, n]));
  const kindCounts = new Map<string, number>();
  for (const n of all) kindCounts.set(n.kind, (kindCounts.get(n.kind) ?? 0) + 1);
  const relCounts = new Map<string, number>();
  const parentOf = new Map<string, string>();
  for (const e of g.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    relCounts.set(e.kind, (relCounts.get(e.kind) ?? 0) + 1);
    if (e.kind === "contains" && !parentOf.has(e.target)) parentOf.set(e.target, e.source);
  }
  const keep = new Set(all.filter((n) => !hiddenKinds.has(n.kind)).map((n) => n.id));
  const links: GLink[] = [];
  const degree = new Map<string, number>();
  const seen = new Set<string>();
  for (const e of g.edges) {
    if (hiddenRels.has(e.kind) || !keep.has(e.source) || !keep.has(e.target) || e.source === e.target) continue;
    const key = `${e.source}>${e.target}>${e.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ source: e.source, target: e.target, kind: e.kind });
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const nodes: GNode[] = [];
  for (const id of keep) {
    const n = byId.get(id)!;
    const d = degree.get(id) ?? 0;
    const base = n.kind === "directory" ? 13 : n.kind === "file" ? 11 : n.kind === "class" ? 10 : 8;
    const label = n.name;
    const full = n.kind === "method" && typeof n.meta.class === "string" ? `${n.meta.class}.${n.name}` : n.name;
    nodes.push({ id, kind: n.kind, label, full, path: n.path, degree: d, r: Math.min(26, base + 1.6 * Math.sqrt(d)), parent: parentOf.get(id) });
  }
  return { nodes, links, kindCounts, relCounts };
}

export type SimLink = GLink & { source: GNode; target: GNode };

// files and folders push each other apart hard while symbols push only a little, so each file's symbols
// gather around it in a tight star and the stars spread out (instead of one even disc)
const CHARGE: Record<string, number> = { directory: -420, file: -260, module: -260, class: -60, dependency: -45 };

/**
 * The physics, shared by the settle worker and the live simulation that follows drags. "contains" builds
 * the star clusters (a file with its symbols, a folder with its files); the other relationships pull only
 * gently, or the many calls would knot everything into one ball. Returned stopped: callers tick it.
 */
export function makeSimulation(nodes: GNode[], links: GLink[]): Simulation<GNode, SimLink> {
  return forceSimulation<GNode, SimLink>(nodes)
    .force(
      "link",
      forceLink<GNode, SimLink>(links as SimLink[])
        .id((d) => d.id)
        .distance((l) => (l.kind === "contains" ? 10 : 80) + l.source.r + l.target.r)
        .strength((l) => (l.kind === "contains" ? 0.9 : l.kind === "calls" ? 0.004 : 0.012)),
    )
    .force("charge", forceManyBody<GNode>().strength((d) => CHARGE[d.kind] ?? -20).theta(0.9).distanceMax(1200))
    .force("collide", forceCollide<GNode>((d) => d.r + 4).iterations(1))
    .force("x", forceX<GNode>(0).strength(0.02))
    .force("y", forceY<GNode>(0).strength(0.02))
    .alphaDecay(0.03)
    .stop();
}

/** Starting positions: kept ones stay, new nodes go next to their container (or on a disc), so stars form fast. */
export function seedPositions(nodes: GNode[], rand: () => number = seededRandom(nodes.length)) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const R = Math.sqrt(nodes.length) * 22;
  let unplaced = nodes.filter((n) => n.x === undefined);
  for (let pass = 0; pass < 6 && unplaced.length; pass++) {
    for (const n of unplaced) {
      const p = n.parent ? byId.get(n.parent) : undefined;
      if (p && p.x !== undefined) {
        const a = rand() * Math.PI * 2;
        n.x = p.x + Math.cos(a) * (p.r + n.r + 20);
        n.y = (p.y ?? 0) + Math.sin(a) * (p.r + n.r + 20);
      } else if (pass === 5 || !p) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * R;
        n.x = Math.cos(a) * d;
        n.y = Math.sin(a) * d;
      }
    }
    unplaced = unplaced.filter((n) => n.x === undefined);
  }
}

/** A small deterministic generator (mulberry32), so the same repository settles into the same picture. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
