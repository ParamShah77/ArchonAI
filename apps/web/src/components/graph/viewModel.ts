/**
 * Turns an API graph into a tidy, drawable view (decisions.md D-023, D-027).
 *
 * - Nesting instead of lines: a node that `contains` another becomes its compound parent (folder box
 *   holding files, file box holding symbols). Those `contains` edges are then not drawn.
 * - External packages are gathered into one "Packages" box; the repo root node and its `depends_on`
 *   spokes are dropped (component → package `imports` edges already show real usage).
 * - Wrapper folders and single-file folders dissolve, loose symbol-less files gather into an "Other files"
 *   box, and methods inside their class box drop the class prefix, so every level reads cleanly.
 * - Each leaf carries its layout footprint: a chip (kind dot + monospace name) plus a little row gap.
 */
import type { Graph, GraphNode } from "@/lib/api";

export const PACKAGES_ID = "__packages__";
export const SYNTHETIC_DIR_PREFIX = "__dir__:";
export const OTHER_FILES_PREFIX = "__files__:";
/** Test code and fixtures (same rule as the backend's TEST_PATH_RE). */
export const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)|(^|\/)test_[^/]+\.py$|[._](test|spec)\.[jt]sx?$|_test\.go$|Test\w*\.java$/;

/** Ids that exist only in the drawing (not in the API graph). */
export const isSynthetic = (id: string) => id.startsWith("__");
const CONTAINER_KINDS = new Set(["directory", "file", "class"]);
export const MAX_SIZE = 26; // largest drawn node
export const CHIP_H = 24; // drawn chip height (world units)
const LEAF_H = 30; // chip + row gap; no separate label slot (the name is inside the chip)
// order of leaves inside a box: entry points and data first, then code, then packages
const KIND_ORDER: Record<string, number> = { endpoint: 0, table: 1, class: 2, function: 3, method: 4, file: 5, directory: 6, dependency: 7 };

export interface ViewNode {
  id: string;
  label: string;
  fullLabel: string; // e.g. "DebtAnalyzer._cycles" for a method shown as "_cycles"
  kind: string;
  parent?: string;
  size: number; // drawn diameter of a leaf
  w: number; // layout footprint
  h: number;
  major: boolean; // labelled at overview zoom
  sortKey: string; // stable order inside a box
  path: string;
  lines: number; // lines of code (0 when unknown)
  isType?: boolean; // TypeScript interface (stored as a class by the extractor)
  priv?: boolean; // Python private helper (single leading underscore, not a dunder)
  isComponent?: boolean; // React component: PascalCase function in a .jsx/.tsx file
  detail?: string; // second line on a symbol card: "(self, repo_id: str) · L42–88 · async", "GET /repos", "1.2.0"
  detail2?: string; // third line: decorators
  test?: boolean; // test code: drawn a little greyer, placed after product code
  tier: number; // ordering tier: 0 product code, 1 tests, 2 groups (Packages, Other files)
  muted?: boolean; // dev-only or test-fixture package: outline-only chip
  inner?: boolean; // a function nested in another function: drawn a little smaller
  quiet?: boolean; // a file with no symbols and no relationships (e.g. an empty __init__.py)
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

/** Extra lines for a symbol card at deep zoom. */
function details(n: GraphNode): { detail?: string; detail2?: string } {
  const m = n.meta;
  const range = n.start_line > 0 ? `L${n.start_line}${n.end_line > n.start_line ? `–${n.end_line}` : ""}` : "";
  if (n.kind === "function" || n.kind === "method") {
    const params = typeof m.params === "string" ? m.params : "";
    const decos = Array.isArray(m.decorators) ? (m.decorators as string[]) : [];
    return {
      detail: [params, range, m.async === true ? "async" : ""].filter(Boolean).join(" · ") || undefined,
      detail2: decos.length ? decos.map((d) => (d.startsWith("@") ? d : `@${d}`)).join(" ") : undefined,
    };
  }
  if (n.kind === "endpoint") return { detail: [m.method, m.route].filter(Boolean).join(" ") || undefined, detail2: range || undefined };
  if (n.kind === "dependency") return { detail: [m.version, m.dev ? "dev" : "", m.ecosystem].filter(Boolean).join(" · ") || undefined };
  if (n.kind === "table") {
    const cols = Array.isArray(m.columns) ? (m.columns as string[]) : [];
    return { detail: [m.model ? `model ${m.model}` : "", cols.length ? `${cols.length} columns` : ""].filter(Boolean).join(" · ") || undefined };
  }
  if (n.kind === "class") {
    const bases = Array.isArray(m.bases) ? (m.bases as string[]) : [];
    return { detail: [bases.length ? `(${bases.join(", ")})` : "", range].filter(Boolean).join(" · ") || undefined };
  }
  return {};
}

export function buildView(g: Graph): ViewModel {
  const byId = new Map(g.nodes.filter((n) => n.kind !== "repo").map((n) => [n.id, n]));

  // 1. parents from `contains` edges (first container wins; the tree has one parent anyway)
  const parentOf = new Map<string, string>();
  for (const e of g.edges) {
    if (e.kind !== "contains") continue;
    const src = byId.get(e.source);
    if (!src || !byId.has(e.target) || !CONTAINER_KINDS.has(src.kind) || parentOf.has(e.target)) continue;
    // an ORM model's table belongs to its file, not inside the class (which would become a box for one chip)
    if (src.kind === "class" && byId.get(e.target)!.kind === "table") continue;
    parentOf.set(e.target, e.source);
  }
  // functions nested in a function (function -> function contains): sorted right after their parent
  const outerOf = new Map<string, string>();
  for (const e of g.edges) {
    if (e.kind !== "contains") continue;
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (a && b && (a.kind === "function" || a.kind === "method") && b.kind === "function") outerOf.set(b.id, a.name);
  }
  // guard against cycles (should not happen, but a cycle would hang the layout)
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
  // Views without folder nodes get folders rebuilt from file paths, so symbols sit in files that sit in folders.
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
  // Compact folders:
  // - a folder that holds only folders is a wrapper: it dissolves and its sub-folders take its place, named
  //   with the path (`apps/api`, `apps/web`), so the overview shows real components as peers;
  // - a folder that holds exactly one file dissolves into that file (`chat/ChatPanel.tsx`): one click less.
  // Folders carry only `contains` edges, so no relationship is lost. Ids stay, so ?node= links still work.
  const labelOverride = new Map<string, string>();
  const nameOf = (id: string) => labelOverride.get(id) ?? byId.get(id)!.name;
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
      const allDirs = cs.every((c) => byId.get(c)?.kind === "directory");
      const singleFile = cs.length === 1 && byId.get(cs[0])?.kind === "file";
      if (!allDirs && !singleFile) continue;
      const grand = parentOf.get(p);
      for (const c of cs) {
        labelOverride.set(c, `${nameOf(p)}/${nameOf(c)}`);
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

  // Empty marker files (no symbols, no relationships, at most 3 lines: an empty __init__.py) carry nothing.
  {
    const touchedFiles = new Set(edges.flatMap((e) => [e.source, e.target]));
    const hasKids = new Set(parentOf.values());
    for (const n of [...byId.values()]) {
      if (n.kind !== "file" || hasKids.has(n.id) || touchedFiles.has(n.id)) continue;
      if (n.end_line <= 3) {
        byId.delete(n.id);
        parentOf.delete(n.id);
      }
    }
  }

  // 3. loose symbol-less files (configs, __init__.py) next to sub-folders gather into one "Other files" box,
  //    instead of floating as specks between big tiles. Only where there are at least two of them.
  const childCount = new Map<string, number>();
  for (const p of parentOf.values()) childCount.set(p, (childCount.get(p) ?? 0) + 1);
  const hasSubBox = new Set<string>(); // parents (or "" for the root) that hold at least one box
  for (const [c, p] of parentOf) if (childCount.has(c)) hasSubBox.add(p);
  for (const n of byId.values()) if (!parentOf.has(n.id) && childCount.has(n.id)) hasSubBox.add("");
  const looseByParent = new Map<string, string[]>();
  for (const n of byId.values()) {
    if (n.kind !== "file" || childCount.has(n.id)) continue;
    const p = parentOf.get(n.id) ?? "";
    if (!hasSubBox.has(p)) continue;
    if (!looseByParent.has(p)) looseByParent.set(p, []);
    looseByParent.get(p)!.push(n.id);
  }
  const otherBoxes: ViewNode[] = [];
  for (const [p, ids] of looseByParent) {
    if (ids.length < 2) continue;
    const id = OTHER_FILES_PREFIX + (p || "root");
    for (const c of ids) parentOf.set(c, id);
    if (p) parentOf.set(id, p);
    otherBoxes.push({
      id,
      label: p ? `Other files (${ids.length})` : `Root files (${ids.length})`,
      fullLabel: p ? "Other files" : "Root files",
      kind: "files",
      tier: 2,
      parent: p || undefined,
      size: 0,
      w: 0,
      h: 0,
      major: false,
      sortKey: "y",
      path: p ? (byId.get(p)?.path ?? "") : "",
      lines: 0,
      synthetic: true,
    });
  }

  // 4. sizes + footprints
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + e.weight);
    degree.set(e.target, (degree.get(e.target) ?? 0) + e.weight);
  }
  const degrees = [...degree.values()].sort((a, b) => b - a);
  const hubCut = degrees[Math.min(degrees.length - 1, Math.max(4, Math.floor(degrees.length * 0.12)))] ?? Infinity;
  const isParent = new Set(parentOf.values());

  const labelOf = (n: GraphNode): { label: string; full: string } => {
    if (n.kind === "method" && typeof n.meta.class === "string") {
      const full = `${n.meta.class}.${n.name}`;
      // inside its class box the class name is already the box title
      const parent = byId.get(parentOf.get(n.id) ?? "");
      return { label: parent?.kind === "class" ? n.name : full, full };
    }
    const label = labelOverride.get(n.id) ?? n.name;
    return { label, full: label };
  };

  const nodes: ViewNode[] = [...byId.values()].map((n) => {
    const d = degree.get(n.id) ?? 0;
    const size = Math.round(12 + (MAX_SIZE - 12) * Math.sqrt(Math.min(d, 40) / 40));
    const { label, full } = labelOf(n);
    const chars = Math.min(label.length, 24);
    const priv = (n.kind === "function" || n.kind === "method") && /^_(?!_)/.test(n.name);
    const test = TEST_PATH_RE.test(n.path) || undefined;
    let sortKey = `${KIND_ORDER[n.kind] ?? 9}${priv ? 1 : 0}${label.toLowerCase()}`; // public before private
    let muted: boolean | undefined;
    if (n.kind === "dependency") {
      // packages: by ecosystem, product before dev before fixtures, most used first
      const fixture = n.meta.fixture === true;
      const dev = n.meta.dev === true;
      muted = fixture || dev || undefined;
      sortKey = `${n.meta.ecosystem ?? ""}${fixture ? 2 : dev ? 1 : 0}${String(9999 - Math.min(9999, d)).padStart(4, "0")}${label.toLowerCase()}`;
    }
    const outer = outerOf.get(n.id);
    if (outer) sortKey = `${KIND_ORDER[n.kind] ?? 9}${priv ? 1 : 0}${outer.toLowerCase()}~${label.toLowerCase()}`;
    return {
      id: n.id,
      label,
      fullLabel: full,
      kind: n.kind,
      parent: parentOf.get(n.id),
      size,
      w: Math.max(size, chars * 6.7 + 34), // room for the chip: kind dot + monospace name
      h: LEAF_H,
      major: isParent.has(n.id) || n.kind === "endpoint" || n.kind === "table" || (d > 0 && d >= hubCut),
      sortKey,
      tier: test ? 1 : 0,
      test,
      muted,
      inner: outer ? true : undefined,
      path: n.path,
      lines: n.end_line > 0 ? n.end_line - Math.max(1, n.start_line) + 1 : 0,
      isType: n.meta.interface === true || undefined,
      priv: priv || undefined,
      isComponent: (n.kind === "function" && /^[A-Z]/.test(n.name) && /\.(jsx|tsx)$/.test(n.path)) || undefined,
      ...details(n),
      quiet: (n.kind === "file" && !isParent.has(n.id) && d === 0) || undefined,
      synthetic: n.meta.synthetic === true || undefined,
    };
  });
  nodes.push(...otherBoxes);
  if ([...byId.values()].some((n) => n.kind === "dependency")) {
    nodes.push({ id: PACKAGES_ID, label: "Packages", fullLabel: "Packages", kind: "group", tier: 2, size: 0, w: 0, h: 0, major: true, sortKey: "z", path: "", lines: 0, synthetic: true });
  }
  return { nodes, edges };
}
