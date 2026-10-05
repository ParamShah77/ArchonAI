/// <reference lib="webworker" />
/**
 * Runs the fCoSE force layout off the main thread (decisions.md D-022).
 *
 * The layout is synchronous CPU work: ~5 s for ~800 nodes in the browser. Done on the main thread it
 * freezes the whole page; here it only delays the moment positions arrive. Cytoscape runs headless.
 */
import cytoscape from "cytoscape";
import fcose from "cytoscape-fcose";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
cytoscape.use(fcose as any);

export interface LayoutRequest {
  id: number;
  nodes: string[];
  edges: [string, string][];
}

export interface LayoutResponse {
  id: number;
  positions?: Record<string, { x: number; y: number }>;
  error?: string;
  ms: number;
}

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const { id, nodes, edges } = ev.data;
  const t0 = performance.now();
  try {
    const cy = cytoscape({ headless: true, styleEnabled: false });
    const known = new Set(nodes);
    cy.add([
      ...nodes.map((n) => ({ group: "nodes" as const, data: { id: n } })),
      ...edges
        .filter(([s, t]) => known.has(s) && known.has(t) && s !== t)
        .map(([s, t], i) => ({ group: "edges" as const, data: { id: `e${i}`, source: s, target: t } })),
    ]);
    const n = nodes.length;
    cy.layout({
      name: "fcose",
      animate: false,
      randomize: true,
      // "default" adds a costly refinement pass; above a few hundred nodes "draft" is ~5x faster and
      // visually close enough for an exploratory map.
      quality: n > 350 ? "draft" : "default",
      nodeRepulsion: () => 6000,
      idealEdgeLength: () => (n > 300 ? 60 : 90),
      edgeElasticity: () => 0.3,
      gravity: 0.35,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).run();
    const positions: Record<string, { x: number; y: number }> = {};
    cy.nodes().forEach((node) => {
      const p = node.position();
      positions[node.id()] = { x: p.x, y: p.y };
    });
    cy.destroy();
    (self as unknown as Worker).postMessage({ id, positions, ms: Math.round(performance.now() - t0) } satisfies LayoutResponse);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String(e), ms: Math.round(performance.now() - t0) } satisfies LayoutResponse);
  }
};
