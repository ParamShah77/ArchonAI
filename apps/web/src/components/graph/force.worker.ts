/**
 * Settles the Graph view's force layout off the main thread (decisions.md D-032): about 200 ticks of a
 * 1,000-node graph cost ~1.5 s of CPU, which would stutter the page and crawl in a throttled tab. The worker
 * ticks as fast as it can and streams positions back about 30 times a second, so the graph visibly flows
 * into place while panning and zooming stay smooth.
 */
import { makeSimulation, type GLink, type GNode } from "./forceData";

export interface ForceRequest {
  id: number;
  nodes: Pick<GNode, "id" | "kind" | "r" | "x" | "y" | "fx" | "fy">[];
  links: { source: string; target: string; kind: string }[];
  alpha: number;
}
export interface ForceResponse {
  id: number;
  xy: Float64Array; // x, y per node, in request order
  done: boolean;
}

let current = 0;

self.onmessage = (ev: MessageEvent<ForceRequest>) => {
  const req = ev.data;
  current = req.id;
  const nodes = req.nodes.map((n) => ({ ...n, label: "", full: "", path: "", degree: 0 })) as GNode[];
  const sim = makeSimulation(nodes, req.links as GLink[]).alpha(req.alpha);
  const send = (done: boolean) => {
    const xy = new Float64Array(nodes.length * 2);
    nodes.forEach((n, i) => {
      xy[i * 2] = n.x ?? 0;
      xy[i * 2 + 1] = n.y ?? 0;
    });
    (self as unknown as Worker).postMessage({ id: req.id, xy, done } satisfies ForceResponse, [xy.buffer]);
  };
  const step = () => {
    if (current !== req.id) return; // a newer request took over
    const t0 = performance.now();
    while (performance.now() - t0 < 33 && sim.alpha() > sim.alphaMin()) sim.tick();
    const done = sim.alpha() <= sim.alphaMin();
    send(done);
    if (!done) setTimeout(step, 0); // yield, so a newer request can arrive
  };
  step();
};
