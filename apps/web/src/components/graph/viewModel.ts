/**
 * Turns an API graph into a tidy, drawable view (decisions.md D-023).
 *
 * - Nesting instead of lines: a node that `contains` another becomes its compound parent (folder box
 *   holding files, file box holding symbols). Those `contains` edges are then not drawn.
 * - External packages are gathered into one "External packages" box; the repo root node and its
 *   `depends_on` spokes are dropped (component → package `imports` edges already show real usage).
 * - Sizes come from a narrow range, and each node carries its layout footprint *including* its label,
 *   so the force layout spaces nodes by what is actually drawn.
 */
import type { Graph, GraphNode } from "@/lib/api";

export const PACKAGES_ID = "__packages__";
export const SYNTHETIC_DIR_PREFIX = "__dir__:";

/** Ids that exist only in the drawing (not in the API graph). */
export const isSynthetic = (id: string) => id.startsWith("__");
const CONTAINER_KINDS = new Set(["directory", "file", "class"]);
export const MAX_SIZE = 26; // largest drawn node
export const LABEL_SLOT = 18; // room under a node for its label
// order of leaves inside a box: entry points and data first, then code, then packages
const KIND_ORDER: Record<string, number> = { endpoint: 0, table: 1, class: 2, function: 3, method: 4, file: 5, directory: 6, dependency: 7 };

export interface ViewNode {
  id: string;
  label: string;
  kind: string;
  parent?: string;
  size: number; // drawn diameter of a leaf
  w: number; // layout footprint (node + label)
  h: number;
  major: boolean; // labelled at overview zoom
  sortKey: string; // stable order inside a box
  path: string;
  synthetic?: boolean;
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight: number;
  external: boolean; // touches an external package
}

export interface ViewModel {
  nodes: ViewNode[];
  edges: ViewEdge[];
}

function labelOf(n: GraphNode): string {
  if (n.kind === "method" && typeof n.meta.class === "string") return `${n.meta.class}.${n.name}`;
  return n.name;
}

export function buildView(g: Graph): ViewModel {
  const byId = new Map(g.nodes.filter((n) => n.kind !== "repo").map((n) => [n.id, n]));

  // 1. parents from `contains` edges (first container wins; the tree has one parent anyway)
  const parentOf = new Map<string, string>();
  for (const e of g.edges) {
    if (e.kind !== "contains") continue;
    const src = byId.get(e.source);
    if (!src || !byId.has(e.target) || !CONTAINER_KINDS.has(src.kind) || parentOf.has(e.target)) continue;
    parentOf.set(e.target, e.source);
  }
  // guard against cycles (should not happen, but a cycle would hang the compound layout)
  for (const id of [...parentOf.keys()]) {
    const seen = new Set<string>([id]);
    let cur = parentOf.get(id);
    while (cur) {
      if (seen.has(cur)) {
        parentOf.delete(id);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }
  // Symbols that hang off a function (endpoints, nested functions) or come from SQL go in their file's box.
  const fileByPath = new Map([...byId.values()].filter((n) => n.kind === "file").map((n) => [n.path, n.id]));
  for (const n of byId.values()) {
    if (parentOf.has(n.id) || n.kind === "file" || n.kind === "directory" || n.kind === "dependency") continue;
    const f = fileByPath.get(n.path);
    if (f && f !== n.id) parentOf.set(n.id, f);
  }
  // Views without folder nodes (the Symbols level) get folders rebuilt from file paths, so symbols sit in
  // files that sit in folders — the same hierarchy as the Files level.
  const hasDirs = [...byId.values()].some((n) => n.kind === "directory");
  if (!hasDirs && fileByPath.size > 1) {
    const ensureDir = (dir: string): string => {
      const id = SYNTHETIC_DIR_PREFIX + dir;
      if (!byId.has(id)) {
        const name = dir.split("/").pop() ?? dir;
        byId.set(id, { id, kind: "directory", name, path: dir, qualified_name: dir, language: "", start_line: 0, end_line: 0, meta: { synthetic: true } });
        const up = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
        if (up) parentOf.set(id, ensureDir(up));
      }
      return id;
    };
    for (const [path, id] of fileByPath) {
      if (parentOf.has(id) || !path.includes("/")) continue;
      parentOf.set(id, ensureDir(path.slice(0, path.lastIndexOf("/"))));
    }
  }
  // Compact folders: a folder that holds only folders (no files of its own) is a wrapper. It dissolves and
  // its sub-folders take its place, named with the path (`apps/api`, `apps/web`). A one-child chain
  // collapses the same way (`api/archon` like VS Code), so the overview shows real components as peers.
  const labelOverride = new Map<string, string>();
  for (let changed = true; changed; ) {
    changed = false;
    const kids = new Map<string, string[]>();
    for (const [c, p] of parentOf) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(c);
    }
    for (const [p, cs] of kids) {
      const pn = byId.get(p);
      if (!pn || pn.kind !== "directory" || !cs.length) continue;
      if (!cs.every((c) => byId.get(c)?.kind === "directory")) continue;
      const grand = parentOf.get(p);
      for (const c of cs) {
        const cn = byId.get(c)!;
        labelOverride.set(c, `${labelOverride.get(p) ?? pn.name}/${labelOverride.get(c) ?? cn.name}`);
        if (grand) parentOf.set(c, grand);
        else parentOf.delete(c);
      }
      parentOf.delete(p);
      byId.delete(p);
      changed = true;
      break; // the child lists changed; rebuild them
    }
  }
  for (const n of byId.values()) if (n.kind === "dependency") parentOf.set(n.id, PACKAGES_ID);

  // 2. edges: drop the ones that nesting already expresses, and edges to a node's own ancestor
  const isAncestor = (a: string, b: string) => {
    for (let cur = parentOf.get(b); cur; cur = parentOf.get(cur)) if (cur === a) return true;
    return false;
  };
  const edges: ViewEdge[] = [];
  for (const e of g.edges) {
    if (!byId.has(e.source) || !byId.has(e.target) || e.source === e.target) continue;
    if (e.kind === "contains" || e.kind === "depends_on") continue;
    if (isAncestor(e.source, e.target) || isAncestor(e.target, e.source)) continue;
    const external = byId.get(e.target)?.kind === "dependency" || byId.get(e.source)?.kind === "dependency";
    edges.push({ id: e.id, source: e.source, target: e.target, kind: e.kind, weight: Number(e.meta.weight ?? 1), external });
  }

  // Packages nothing in this view uses would only crowd it (the server includes all of them everywhere).
  const touched = new Set(edges.flatMap((e) => [e.source, e.target]));
  for (const n of [...byId.values()]) {
    if (n.kind === "dependency" && !touched.has(n.id)) {
      byId.delete(n.id);
      parentOf.delete(n.id);
    }
  }

  // 3. sizes + label footprints
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + e.weight);
    degree.set(e.target, (degree.get(e.target) ?? 0) + e.weight);
  }
  const degrees = [...degree.values()].sort((a, b) => b - a);
  const hubCut = degrees[Math.min(degrees.length - 1, Math.max(4, Math.floor(degrees.length * 0.12)))] ?? Infinity;
  const isParent = new Set(parentOf.values());

  const nodes: ViewNode[] = [...byId.values()].map((n) => {
    const d = degree.get(n.id) ?? 0;
    const size = Math.round(12 + (MAX_SIZE - 12) * Math.sqrt(Math.min(d, 40) / 40));
    const label = labelOverride.get(n.id) ?? labelOf(n);
    const chars = Math.min(label.length, 24);
    return {
      id: n.id,
      label,
      kind: n.kind,
      parent: parentOf.get(n.id),
      size,
      w: Math.max(size, chars * 6.7 + 34), // room for the chip: kind dot + monospace name
      h: MAX_SIZE + LABEL_SLOT, // same slot height for every node so rows line up
      major: isParent.has(n.id) || n.kind === "endpoint" || n.kind === "table" || (d > 0 && d >= hubCut),
      sortKey: `${KIND_ORDER[n.kind] ?? 9}${label.toLowerCase()}`,
      path: n.path,
      synthetic: n.meta.synthetic === true || undefined,
    };
  });
  if ([...byId.values()].some((n) => n.kind === "dependency")) {
    const count = nodes.filter((n) => n.parent === PACKAGES_ID).length;
    nodes.push({ id: PACKAGES_ID, label: `Packages (${count})`, kind: "group", size: 0, w: 0, h: 0, major: true, sortKey: "z", path: "", synthetic: true });
  }
  return { nodes, edges };
}
