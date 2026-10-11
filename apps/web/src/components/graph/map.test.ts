import { describe, expect, it } from "vitest";
import type { Graph, GraphEdge, GraphNode } from "@/lib/api";
import { runLayout, type LayoutEdge } from "./layoutCore";
import { buildMapModel } from "./mapModel";
import { fitParts, fitSmart, type FontSpec } from "./mapText";
import { boxPalette, chipPalette, contrast, HEALTH_TILES, MAP_INK, MAP_MUTED, mixOklab } from "./palette";
import { buildView } from "./viewModel";

// ---- tiny graph builder --------------------------------------------------------------------------------------
let seq = 0;
function node(kind: GraphNode["kind"], name: string, path: string, meta: Record<string, unknown> = {}, lines = 10): GraphNode {
  return { id: `n${++seq}`, kind, name, path, qualified_name: `${path}::${name}`, language: "python", start_line: 1, end_line: lines, meta };
}
function edge(source: GraphNode, target: GraphNode, kind: GraphEdge["kind"]): GraphEdge {
  return { id: `e${++seq}`, source: source.id, target: target.id, kind, meta: {} } as GraphEdge;
}
function graph(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes, edges } as unknown as Graph;
}
function layoutOf(g: Graph) {
  const view = buildView(g);
  const nodes = view.nodes.map((n) => ({ id: n.id, parent: n.parent, w: n.w, h: n.h, size: n.size, sortKey: n.sortKey, kind: n.kind, priv: n.priv, tier: n.tier, path: n.path }));
  const edges = view.edges.map((e) => [e.source, e.target, e.kind] as LayoutEdge);
  return { view, pos: runLayout(nodes, edges) };
}

/** A small repo: two folders, a file with a call chain, a class with methods, an empty __init__.py. */
function sampleRepo() {
  const app = node("directory", "app", "app");
  const svc = node("directory", "services", "app/services");
  const util = node("directory", "util", "app/util");
  const f = node("file", "orders.py", "app/services/orders.py", {}, 120);
  const init = node("file", "__init__.py", "app/services/__init__.py", {}, 0);
  const h = node("file", "helpers.py", "app/util/helpers.py", {}, 40);
  const entry = node("function", "place_order", f.path);
  const mid = node("function", "validate", f.path);
  const leaf = node("function", "_save", f.path);
  const lone = node("function", "describe", f.path);
  const cls = node("class", "Order", f.path);
  const m1 = node("method", "total", f.path, { class: "Order" });
  const m2 = node("method", "tax", f.path, { class: "Order" });
  const hf = node("function", "fmt", h.path);
  const hf2 = node("function", "parse", h.path);
  const nodes = [app, svc, util, f, init, h, entry, mid, leaf, lone, cls, m1, m2, hf, hf2];
  const edges = [
    edge(app, svc, "contains"),
    edge(app, util, "contains"),
    edge(svc, f, "contains"),
    edge(svc, init, "contains"),
    edge(util, h, "contains"),
    edge(f, entry, "contains"),
    edge(f, mid, "contains"),
    edge(f, leaf, "contains"),
    edge(f, lone, "contains"),
    edge(f, cls, "contains"),
    edge(cls, m1, "contains"),
    edge(cls, m2, "contains"),
    edge(h, hf, "contains"),
    edge(h, hf2, "contains"),
    edge(entry, mid, "calls"),
    edge(mid, leaf, "calls"),
    edge(entry, leaf, "calls"),
    edge(f, h, "imports"),
  ];
  return { g: graph(nodes, edges), ids: { f, init, entry, mid, leaf, m1, cls, h } };
}

describe("view model", () => {
  it("shortens methods inside their class box and keeps the full name for tooltips", () => {
    const { g, ids } = sampleRepo();
    const v = buildView(g);
    const m = v.nodes.find((n) => n.id === ids.m1.id)!;
    expect(m.label).toBe("total");
    expect(m.fullLabel).toBe("Order.total");
  });

  it("hides empty marker files and puts public symbols before private ones", () => {
    const { g, ids } = sampleRepo();
    const v = buildView(g);
    expect(v.nodes.some((n) => n.id === ids.init.id)).toBe(false);
    const pub = v.nodes.find((n) => n.id === ids.mid.id)!;
    const priv = v.nodes.find((n) => n.id === ids.leaf.id)!;
    expect(priv.priv).toBe(true);
    expect(pub.sortKey < priv.sortKey).toBe(true);
  });

  it("merges a folder holding a single file into that file", () => {
    const { g, ids } = sampleRepo();
    const v = buildView(g);
    const h = v.nodes.find((n) => n.id === ids.h.id)!;
    // `app` holds only folders, so it dissolves too: the merged tile is named with the whole path
    expect(h.label).toBe("app/util/helpers.py");
  });
});

describe("layout", () => {
  it("never overlaps siblings", () => {
    const { view, pos } = layoutOf(sampleRepo().g);
    const kids = new Map<string, string[]>();
    for (const n of view.nodes) {
      const p = n.parent ?? "";
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p)!.push(n.id);
    }
    for (const ids of kids.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = pos[ids[i]], b = pos[ids[j]];
          const overlap = Math.abs(a.x - b.x) < (a.w + b.w) / 2 - 0.01 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 - 0.01;
          expect(overlap, `${ids[i]} overlaps ${ids[j]}`).toBe(false);
        }
      }
    }
  });

  it("puts callers above (or beside) what they call inside a file, also next to classes", () => {
    const { g, ids } = sampleRepo();
    // a longer call chain in the same file, so the layers must wrap onto several rows
    const chain = [ids.entry, ids.mid, ids.leaf];
    for (let i = 0; i < 6; i++) {
      const fn = node("function", `step_${i}`, ids.f.path);
      g.nodes.push(fn);
      g.edges.push(edge(ids.f, fn, "contains"), edge(chain[chain.length - 1], fn, "calls"));
      chain.push(fn);
    }
    const { pos } = layoutOf(g);
    for (let i = 1; i < chain.length; i++) expect(pos[chain[i - 1].id].y).toBeLessThanOrEqual(pos[chain[i].id].y);
    expect(pos[chain[0].id].y).toBeLessThan(pos[chain[chain.length - 1].id].y);
  });
});

describe("map model", () => {
  it("builds integer edge arrays that match the edges", () => {
    const { view, pos } = layoutOf(sampleRepo().g);
    const m = buildMapModel(view, pos);
    expect(m.eSrc.length).toBe(m.edges.length);
    m.edges.forEach((e, i) => {
      expect(m.byIndex[m.eSrc[i]].id).toBe(e.source);
      expect(m.byIndex[m.eTgt[i]].id).toBe(e.target);
      expect(m.kindNames[m.eKind[i]]).toBe(e.kind);
    });
    for (const n of m.nodes.values()) expect(Array.from(m.chain[n.index])).toEqual([n.index, ...n.ancestors.map((a) => m.nodes.get(a)!.index)]);
  });

  it("counts who uses a file", () => {
    const { g, ids } = sampleRepo();
    const { view, pos } = layoutOf(g);
    const m = buildMapModel(view, pos);
    expect(m.nodes.get(ids.h.id)!.fanIn).toBe(1);
    expect(m.nodes.get(ids.f.id)!.fanOut).toBe(1);
  });
});

describe("palette", () => {
  it("keeps every text colour readable (WCAG AA 4.5:1) on every surface", () => {
    for (let area = 0; area < 8; area++) {
      for (const depth of [0, 1, 2, 5]) {
        for (const test of [false, true]) {
          const p = boxPalette(area, depth, false, test);
          const tile = mixOklab(p.tileTop, p.tileBottom, 0.5);
          expect(contrast(MAP_INK, tile)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(p.sub, tile)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(p.title, p.band)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(MAP_MUTED, p.frame)).toBeGreaterThanOrEqual(4.5);
          // a closed tile stays clearly brighter than the open surface it sits on
          expect(contrast(tile, p.frame)).toBeGreaterThanOrEqual(1.4);
        }
      }
    }
  });

  it("keeps names readable on symbol chips and Health tiles", () => {
    const surface = boxPalette(0, 2, false).frameL;
    for (const priv of [false, true]) expect(contrast(MAP_INK, chipPalette("#9ccfac", surface, priv).fill)).toBeGreaterThanOrEqual(7);
    for (const t of HEALTH_TILES) expect(contrast(MAP_INK, mixOklab(t.top, t.bottom, 0.5))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("text fitting", () => {
  // a fake 2D context: every character is 7 px wide at 12 px
  const ctx = { font: "", measureText: (s: string) => ({ width: s.length * 7 }) } as unknown as CanvasRenderingContext2D;
  const f: FontSpec = { weight: 400, size: 12, family: "x" };

  it("keeps a file's extension and ending when shortening", () => {
    const out = fitSmart(ctx, "RepoOverview.tsx", f, 70);
    expect(out.endsWith(".tsx")).toBe(true);
    expect(out).toContain("…");
  });

  it("drops a merged folder before cutting the file name", () => {
    expect(fitSmart(ctx, "chat/ChatPanel.tsx", f, 110)).toBe("…/ChatPanel.tsx");
  });

  it("drops whole summary parts instead of cutting words", () => {
    expect(fitParts(ctx, ["10 endpoints", "12 functions"], f, 90)).toBe("10 endpoints");
  });
});
