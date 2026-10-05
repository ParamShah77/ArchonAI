"use client";

import { useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import { EDGE_STYLE, KIND_STYLE, type Graph, type NodeKind } from "@/lib/api";
import { cachedLayout, computeLayout, graphKey, type Positions } from "./layoutClient";

interface Props {
  graph: Graph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDrill: (id: string) => void;
}

/** Above this many elements the map switches to cheaper drawing (straight edges, no arrows). */
const LARGE = 1200;
// Canvas text cannot resolve CSS variables, so the font stack is spelled out.
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function label(n: Graph["nodes"][number]): string {
  if (n.kind === "method" && typeof n.meta.class === "string") return `${n.meta.class}.${n.name}`;
  return n.name;
}

function toElements(g: Graph, positions?: Positions): ElementDefinition[] {
  const degree = new Map<string, number>();
  for (const e of g.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  // Until the worker answers, nodes sit on a spiral: cheap, deterministic, and nothing overlaps.
  const nodes: ElementDefinition[] = g.nodes.map((n, i) => ({
    data: { id: n.id, label: label(n), kind: n.kind, degree: degree.get(n.id) ?? 0, path: n.path },
    position: positions?.[n.id] ?? { x: Math.cos(i * 0.5) * (20 + i * 3), y: Math.sin(i * 0.5) * (20 + i * 3) },
  }));
  const edges: ElementDefinition[] = g.edges.map((e) => ({
    data: { id: e.id, source: e.source, target: e.target, kind: e.kind, weight: e.meta.weight ?? 1 },
  }));
  return [...nodes, ...edges];
}

type LayoutState = { state: "idle" } | { state: "running"; nodes: number } | { state: "error"; message: string };

export function GraphCanvas({ graph, selected, onSelect, onDrill }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const graphRef = useRef(graph);
  const renderSeq = useRef(0);
  const [layout, setLayout] = useState<LayoutState>({ state: "idle" });
  const handlers = useRef({ onSelect, onDrill });
  useEffect(() => {
    handlers.current = { onSelect, onDrill };
    graphRef.current = graph;
  });

  /** Put the graph on screen immediately, then apply worker-computed positions when they arrive. */
  const render = (cy: Core, g: Graph) => {
    const seq = ++renderSeq.current;
    const key = graphKey(g);
    const cached = cachedLayout(key);
    const large = g.nodes.length + g.edges.length > LARGE;
    cy.resize();
    cy.batch(() => {
      cy.elements().remove();
      cy.add(toElements(g, cached));
      cy.style()
        .selector("edge")
        .style({ "curve-style": large ? "straight" : "bezier", "target-arrow-shape": large ? "none" : "triangle" })
        .update();
    });
    cy.fit(undefined, 40);
    if (cached) {
      setLayout({ state: "idle" });
      return;
    }
    setLayout({ state: "running", nodes: g.nodes.length });
    computeLayout(g, key).then(
      (pos) => {
        if (seq !== renderSeq.current || cyRef.current !== cy) return; // a newer view replaced this one
        setLayout({ state: "idle" });
        cy.layout({
          name: "preset",
          positions: (n: { id: () => string }) => pos[n.id()],
          animate: g.nodes.length < 400,
          animationDuration: 400,
          fit: true,
          padding: 40,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any).run();
      },
      (err: Error) => {
        if (seq !== renderSeq.current || err.message === "superseded") return;
        setLayout({ state: "error", message: err.message });
      },
    );
  };
  const renderRef = useRef(render);
  useEffect(() => {
    renderRef.current = render;
  });

  // Create the Cytoscape instance once; the library is loaded client-side only.
  useEffect(() => {
    let disposed = false;
    (async () => {
      const { default: cytoscape } = await import("cytoscape");
      if (disposed || !ref.current) return;
      const cy = cytoscape({
        container: ref.current,
        // Draw a cached bitmap while panning/zooming instead of re-rendering every element per frame.
        textureOnViewport: true,
        motionBlur: false,
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              color: "#e6e9ef",
              "font-size": 10,
              "font-family": MONO,
              "text-valign": "bottom",
              "text-margin-y": 4,
              "text-max-width": "140px",
              "text-wrap": "ellipsis",
              "background-opacity": 0.9,
              "border-width": 1.5,
              "border-color": "#0b0d12",
              width: "mapData(degree, 0, 30, 14, 42)",
              height: "mapData(degree, 0, 30, 14, 42)",
              "min-zoomed-font-size": 8,
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
      // Follow the container size (panel open/close, window resize). Only re-fit on real size changes.
      let last = "";
      const ro = new ResizeObserver(([entry]) => {
        const size = `${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
        if (size === last) return;
        last = size;
        cy.resize();
        cy.fit(undefined, 40);
      });
      ro.observe(ref.current);
      roRef.current = ro;
      renderRef.current(cy, graphRef.current);
    })();
    return () => {
      disposed = true; // late layout results are ignored: render() checks cyRef.current against its instance
      roRef.current?.disconnect();
      roRef.current = null;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (cyRef.current) renderRef.current(cyRef.current, graph);
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

  return (
    <>
      {/* Inline position: Cytoscape's injected stylesheet sets `position: relative` on its container,
          which beats Tailwind's layered `absolute` utility and collapses the canvas to 0px height. */}
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      {layout.state === "running" && (
        <div className="absolute top-3 right-3 z-10 chip pointer-events-none">
          <span className="h-1.5 w-1.5 rounded-full bg-accent pulse" /> arranging {layout.nodes} nodes…
        </div>
      )}
      {layout.state === "error" && (
        <div className="absolute top-3 right-3 z-10 chip text-danger border-danger/40">layout failed: {layout.message}</div>
      )}
    </>
  );
}
