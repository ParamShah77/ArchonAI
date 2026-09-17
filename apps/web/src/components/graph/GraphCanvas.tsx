"use client";

import { useEffect, useRef } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import { EDGE_STYLE, KIND_STYLE, type Graph, type NodeKind } from "@/lib/api";

interface Props {
  graph: Graph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDrill: (id: string) => void;
}

function label(n: Graph["nodes"][number]): string {
  if (n.kind === "endpoint") return n.name;
  if (n.kind === "directory" || n.kind === "file") return n.name;
  if (n.kind === "method" && typeof n.meta.class === "string") return `${n.meta.class}.${n.name}`;
  return n.name;
}

function toElements(g: Graph): ElementDefinition[] {
  const degree = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const nodes: ElementDefinition[] = g.nodes.map((n) => ({
    data: { id: n.id, label: label(n), kind: n.kind, degree: degree.get(n.id) ?? 0, path: n.path },
  }));
  const edges: ElementDefinition[] = g.edges.map((e) => ({
    data: { id: e.id, source: e.source, target: e.target, kind: e.kind, weight: e.meta.weight ?? 1 },
  }));
  return [...nodes, ...edges];
}

export function GraphCanvas({ graph, selected, onSelect, onDrill }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const handlers = useRef({ onSelect, onDrill });
  useEffect(() => {
    handlers.current = { onSelect, onDrill };
  });

  // Create the Cytoscape instance once; the library is loaded client-side only.
  useEffect(() => {
    let disposed = false;
    (async () => {
      const [{ default: cytoscape }, { default: fcose }] = await Promise.all([import("cytoscape"), import("cytoscape-fcose")]);
      if (disposed || !ref.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cytoscape.use(fcose as any);
      const cy = cytoscape({
        container: ref.current,
        wheelSensitivity: 0.2,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              color: "#e6e9ef",
              "font-size": 10,
              "font-family": "var(--font-geist-mono), monospace",
              "text-valign": "bottom",
              "text-margin-y": 4,
              "text-max-width": "140px",
              "text-wrap": "ellipsis",
              "background-opacity": 0.9,
              "border-width": 1.5,
              "border-color": "#0b0d12",
              width: "mapData(degree, 0, 30, 14, 42)",
              height: "mapData(degree, 0, 30, 14, 42)",
              "min-zoomed-font-size": 7,
            },
          },
          ...(Object.keys(KIND_STYLE) as NodeKind[]).map((k) => ({
            selector: `node[kind = "${k}"]`,
            style: { "background-color": KIND_STYLE[k].color, shape: KIND_STYLE[k].shape },
          })),
          {
            selector: "edge",
            style: {
              width: "mapData(weight, 1, 20, 1, 4)",
              "curve-style": "bezier",
              "target-arrow-shape": "triangle",
              "arrow-scale": 0.7,
              opacity: 0.6,
            },
          },
          ...Object.entries(EDGE_STYLE).map(([k, s]) => ({
            selector: `edge[kind = "${k}"]`,
            style: { "line-color": s.color, "target-arrow-color": s.color, "line-style": s.style },
          })),
          { selector: 'edge[kind = "contains"]', style: { "target-arrow-shape": "none", opacity: 0.35 } },
          { selector: "node:selected", style: { "border-color": "#ffffff", "border-width": 3 } },
          { selector: ".dim", style: { opacity: 0.12 } },
          { selector: ".hl", style: { opacity: 1 } },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      cy.on("tap", "node", (ev) => handlers.current.onSelect(ev.target.id()));
      cy.on("tap", (ev) => {
        if (ev.target === cy) handlers.current.onSelect(null);
      });
      cy.on("dbltap", "node", (ev) => handlers.current.onDrill(ev.target.id()));
      cyRef.current = cy;
      // The canvas must follow its container (panel open/close, window resize, late layout).
      const ro = new ResizeObserver(() => {
        cy.resize();
        cy.fit(undefined, 40);
      });
      ro.observe(ref.current);
      roRef.current = ro;
      render(cy, graph);
    })();
    return () => {
      disposed = true;
      roRef.current?.disconnect();
      roRef.current = null;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (cyRef.current) render(cyRef.current, graph);
  }, [graph]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().removeClass("dim hl");
      cy.$(":selected").unselect();
      if (!selected) return;
      const n = cy.getElementById(selected);
      if (n.empty()) return;
      n.select();
      const hood = n.closedNeighborhood();
      cy.elements().not(hood).addClass("dim");
      hood.addClass("hl");
    });
  }, [selected, graph]);

  // Inline position: Cytoscape's injected stylesheet sets `position: relative` on its container, which
  // beats Tailwind's layered `absolute` utility and collapses the canvas to 0px height.
  return <div ref={ref} style={{ position: "absolute", inset: 0 }} />;
}

function render(cy: Core, graph: Graph) {
  cy.resize();
  cy.batch(() => {
    cy.elements().remove();
    cy.add(toElements(graph));
  });
  const n = graph.nodes.length;
  cy.layout({
    name: "fcose",
    animate: n < 400,
    animationDuration: 500,
    randomize: true,
    quality: n > 800 ? "draft" : "default",
    nodeRepulsion: () => 6000,
    idealEdgeLength: () => (n > 300 ? 60 : 90),
    edgeElasticity: () => 0.3,
    gravity: 0.35,
    padding: 40,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any).run();
}
