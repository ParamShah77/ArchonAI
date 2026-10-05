"use client";

import { useEffect, useRef, useState } from "react";
import type { Core, ElementDefinition } from "cytoscape";
import { EDGE_STYLE, KIND_STYLE, type Graph, type NodeKind } from "@/lib/api";
import { cachedLayout, computeLayout, viewKey, type Positions } from "./layoutClient";
import { buildView, isSynthetic, PACKAGES_ID, type ViewModel } from "./viewModel";

interface Props {
  graph: Graph;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onDrill: (id: string) => void;
}

/** Above this many elements the map switches to cheaper drawing (straight edges, no arrows). */
const LARGE = 1500;
// Canvas text cannot resolve CSS variables, so the font stack is spelled out.
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const BG = "#0b0d12";

function toElements(v: ViewModel, positions?: Positions): ElementDefinition[] {
  const parents = new Set(v.nodes.map((n) => n.parent).filter(Boolean));
  const leaves = v.nodes.filter((n) => !parents.has(n.id));
  const leafIndex = new Map(leaves.map((n, i) => [n.id, i]));
  return [
    ...v.nodes.map((n) => {
      const i = leafIndex.get(n.id);
      // Until the worker answers, leaves sit on a spiral: cheap, deterministic, nothing stacked.
      const position =
        i === undefined ? undefined : (positions?.[n.id] ?? { x: Math.cos(i * 0.5) * (30 + i * 4), y: Math.sin(i * 0.5) * (30 + i * 4) });
      return {
        data: { id: n.id, parent: n.parent, label: n.label, kind: n.kind, size: n.size, path: n.path },
        classes: [n.major ? "major" : "", n.id === PACKAGES_ID ? "packages" : ""].filter(Boolean).join(" "),
        ...(position ? { position } : {}),
      };
    }),
    ...v.edges.map((e) => ({
      data: { id: e.id, source: e.source, target: e.target, kind: e.kind, weight: e.weight },
      classes: e.external ? "external" : "",
    })),
  ];
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

  /** Show the grouped view immediately, then apply worker-computed positions when they arrive. */
  const render = (cy: Core, g: Graph) => {
    const seq = ++renderSeq.current;
    const view = buildView(g);
    const key = viewKey(view);
    const cached = cachedLayout(key);
    const large = view.nodes.length + view.edges.length > LARGE;
    cy.resize();
    cy.batch(() => {
      cy.elements().remove();
      cy.add(toElements(view, cached));
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
    setLayout({ state: "running", nodes: view.nodes.length });
    computeLayout(view, key).then(
      (pos) => {
        if (seq !== renderSeq.current || cyRef.current !== cy) return; // a newer view replaced this one
        setLayout({ state: "idle" });
        cy.nodes()
          .filter((n) => n.isChildless())
          .layout({
            name: "preset",
            positions: (n: { id: () => string }) => pos[n.id()],
            // animations only advance while the page is visible; a background tab gets the final layout at once
            animate: view.nodes.length < 300 && document.visibilityState === "visible",
            animationDuration: 350,
            fit: true, // fits the final positions, animated or not
            padding: 50,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)
          .run();
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
        textureOnViewport: true, // draw a cached bitmap while panning/zooming
        motionBlur: false,
        minZoom: 0.08,
        maxZoom: 3,
        style: [
          // ---- leaves
          {
            selector: "node",
            style: {
              width: "data(size)",
              height: "data(size)",
              "background-opacity": 0.95,
              "border-width": 1,
              "border-color": BG,
              label: "data(label)",
              color: "#d6dae3",
              "font-size": 9,
              "font-family": MONO,
              "text-valign": "bottom",
              "text-margin-y": 3,
              "text-max-width": "150px",
              "text-wrap": "ellipsis",
              // labels sit on a dark pill so lines behind them do not make them unreadable
              "text-background-color": BG,
              "text-background-opacity": 0.85,
              "text-background-padding": "2px",
              "text-background-shape": "roundrectangle",
              // minor labels appear only once the user zooms in (or selects/hovers)
              "min-zoomed-font-size": 11,
            },
          },
          ...(Object.keys(KIND_STYLE) as NodeKind[]).map((k) => ({
            selector: `node[kind = "${k}"]`,
            style: { "background-color": KIND_STYLE[k].color, shape: KIND_STYLE[k].shape },
          })),
          { selector: "node.major", style: { "font-size": 11, "font-weight": "bold", color: "#eef1f6", "min-zoomed-font-size": 6 } },
          // ---- compound boxes (folders, files holding symbols, the packages group)
          {
            selector: ":parent",
            style: {
              shape: "round-rectangle",
              "background-color": "#8b93a7",
              "background-opacity": 0.05,
              "border-width": 1,
              "border-color": "#3a4152",
              "border-opacity": 1,
              padding: "16px",
              "text-valign": "top",
              "text-halign": "center",
              "text-margin-y": -4,
              "font-size": 11,
              "font-weight": "bold",
              color: "#9aa3b5",
              "text-background-opacity": 0,
              "text-max-width": "600px", // box titles are paths; never cut them like node names
              "text-wrap": "none",
              "min-zoomed-font-size": 5,
            },
          },
          { selector: ':parent[kind = "file"]', style: { "background-color": KIND_STYLE.file.color, "background-opacity": 0.06, "border-color": "#2b4a6e" } },
          { selector: ':parent[kind = "class"]', style: { "background-color": KIND_STYLE.class.color, "background-opacity": 0.06, "border-color": "#5b4470" } },
          { selector: "node.packages", style: { "background-color": KIND_STYLE.dependency.color, "background-opacity": 0.04, "border-style": "dashed", "border-color": "#6b6740", color: "#c9c07a" } },
          // ---- edges: thin and quiet; emphasised only around the selection
          {
            selector: "edge",
            style: {
              width: "mapData(weight, 1, 20, 0.8, 3)",
              "curve-style": "bezier",
              "target-arrow-shape": "triangle",
              "arrow-scale": 0.55,
              opacity: 0.22,
            },
          },
          ...Object.entries(EDGE_STYLE).map(([k, s]) => ({
            selector: `edge[kind = "${k}"]`,
            style: { "line-color": s.color, "target-arrow-color": s.color, "line-style": s.style },
          })),
          // ---- interaction states
          { selector: "node:selected", style: { "border-color": "#ffffff", "border-width": 2.5 } },
          { selector: ".dim", style: { opacity: 0.1, "text-opacity": 0 } },
          { selector: "node.hl, node.hover", style: { "min-zoomed-font-size": 0, "z-index": 10 } },
          // lines into the packages box are the noisiest and least informative at overview: nearly hidden
          { selector: "edge.external", style: { opacity: 0.07 } },
          { selector: "edge.hl, edge.hover", style: { opacity: 0.95, width: 2, "z-index": 9 } },
          { selector: ":parent.dim", style: { opacity: 0.35, "text-opacity": 1 } },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const real = (id: string) => !isSynthetic(id);
      cy.on("tap", "node", (ev) => {
        if (real(ev.target.id())) handlers.current.onSelect(ev.target.id());
      });
      cy.on("tap", (ev) => {
        if (ev.target === cy) handlers.current.onSelect(null);
      });
      cy.on("dbltap", "node", (ev) => {
        if (real(ev.target.id())) handlers.current.onDrill(ev.target.id());
      });
      // hovering a node or a box lights up every line in or out of it
      cy.on("mouseover", "node", (ev) => {
        ev.target.addClass("hover");
        ev.target.union(ev.target.descendants()).connectedEdges().addClass("hover");
      });
      cy.on("mouseout", "node", (ev) => {
        ev.target.removeClass("hover");
        cy.edges(".hover").removeClass("hover");
      });
      // double-clicking a rebuilt folder drills into it like a real one
      cy.on("dbltap", "node", (ev) => {
        const id: string = ev.target.id();
        if (id.startsWith("__dir__:")) handlers.current.onDrill(id);
      });
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
      // the node, its neighbours, the edges between them, and every box they sit in stay lit
      const hood = n.closedNeighborhood();
      const lit = hood.union(hood.nodes().ancestors()).union(n.descendants());
      cy.elements().not(lit).addClass("dim");
      lit.addClass("hl");
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
