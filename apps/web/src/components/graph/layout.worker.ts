/// <reference lib="webworker" />
/**
 * Runs the map layout off the main thread (decisions.md D-022). The computation lives in layoutCore.ts.
 */
import { type LayoutRequest, type LayoutResponse, runLayout } from "./layoutCore";

export type { LayoutRequest, LayoutResponse } from "./layoutCore";

self.onmessage = (ev: MessageEvent<LayoutRequest>) => {
  const { id, nodes, edges } = ev.data;
  const t0 = performance.now();
  try {
    const positions = runLayout(nodes, edges);
    (self as unknown as Worker).postMessage({ id, positions, ms: Math.round(performance.now() - t0) } satisfies LayoutResponse);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String(e), ms: Math.round(performance.now() - t0) } satisfies LayoutResponse);
  }
};
