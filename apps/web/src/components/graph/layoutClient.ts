/**
 * Client for the layout worker (decisions.md D-022).
 *
 * - One worker at a time. A newer request terminates a still-running older one, because a force layout
 *   cannot be interrupted from outside and the old result would be thrown away anyway.
 * - Positions are cached per graph shape, so returning to a view (level, focus, filter) is instant.
 */
import type { Graph } from "@/lib/api";
import type { LayoutRequest, LayoutResponse } from "./layout.worker";

export type Positions = Record<string, { x: number; y: number }>;

const CACHE_LIMIT = 24;
const cache = new Map<string, Positions>();
let worker: Worker | null = null;
let busy = false;
let seq = 0;
const pending = new Map<number, { resolve: (p: Positions) => void; reject: (e: Error) => void }>();

/** Cheap, stable signature of the graph's shape (node ids + edges). */
export function graphKey(g: Graph): string {
  let h = 2166136261;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  };
  for (const n of [...g.nodes].map((x) => x.id).sort()) mix(n);
  for (const e of [...g.edges].map((x) => `${x.source}>${x.target}`).sort()) mix(e);
  return `${g.nodes.length}:${g.edges.length}:${(h >>> 0).toString(36)}`;
}

function spawn(): Worker {
  const w = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (ev: MessageEvent<LayoutResponse>) => {
    busy = false;
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    if (ev.data.positions) p.resolve(ev.data.positions);
    else p.reject(new Error(ev.data.error ?? "layout failed"));
  };
  w.onerror = (ev) => {
    busy = false;
    for (const [, p] of pending) p.reject(new Error(ev.message || "layout worker crashed"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return w;
}

export function cachedLayout(key: string): Positions | undefined {
  return cache.get(key);
}

export function computeLayout(g: Graph, key: string): Promise<Positions> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  if (busy && worker) {
    // Abandon the stale layout: killing the worker is the only way to stop a running fCoSE pass.
    worker.terminate();
    worker = null;
    for (const [, p] of pending) p.reject(new Error("superseded"));
    pending.clear();
  }
  worker ??= spawn();
  const id = ++seq;
  const req: LayoutRequest = {
    id,
    nodes: g.nodes.map((n) => n.id),
    edges: g.edges.map((e) => [e.source, e.target]),
  };
  return new Promise<Positions>((resolve, reject) => {
    pending.set(id, {
      resolve: (pos) => {
        cache.set(key, pos);
        if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
        resolve(pos);
      },
      reject,
    });
    busy = true;
    worker!.postMessage(req);
  });
}
