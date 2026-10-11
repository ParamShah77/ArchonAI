/**
 * Client for the layout worker (decisions.md D-022).
 *
 * - One worker at a time. A newer request terminates a still-running older one, because a force layout
 *   cannot be interrupted from outside and the old result would be thrown away anyway.
 * - Positions are cached per graph shape, so returning to a view (level, focus, filter) is instant.
 */
import type { LayoutRequest, LayoutResponse } from "./layout.worker";
import type { ViewModel } from "./viewModel";

import type { Rect } from "./layoutCore";

export type Positions = Record<string, Rect>;

const CACHE_LIMIT = 24;
// bump when the layout algorithm changes, so cached positions from the old one are not reused
const LAYOUT_VERSION = 5;
const cache = new Map<string, Positions>();
let worker: Worker | null = null;
let busy = false;
let seq = 0;
const pending = new Map<number, { resolve: (p: Positions) => void; reject: (e: Error) => void }>();

/** Cheap, stable signature of the view's shape (nodes, nesting, sizes, edges). */
export function viewKey(v: ViewModel): string {
  let h = 2166136261;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  };
  for (const n of [...v.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) mix(`${n.id}|${n.parent ?? ""}|${n.w}|${n.h}|${n.sortKey}`);
  for (const e of [...v.edges].map((x) => `${x.source}>${x.target}:${x.kind}`).sort()) mix(e);
  return `v${LAYOUT_VERSION}:${v.nodes.length}:${v.edges.length}:${(h >>> 0).toString(36)}`;
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

export function computeLayout(v: ViewModel, key: string): Promise<Positions> {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  if (busy && worker) {
    // Abandon the stale layout: killing the worker is the only way to stop a running pass.
    worker.terminate();
    worker = null;
    for (const [, p] of pending) p.reject(new Error("superseded"));
    pending.clear();
  }
  worker ??= spawn();
  const id = ++seq;
  const req: LayoutRequest = {
    id,
    nodes: v.nodes.map((n) => ({ id: n.id, parent: n.parent, w: n.w, h: n.h, size: n.size, sortKey: n.sortKey, kind: n.kind, priv: n.priv, tier: n.tier, path: n.path })),
    edges: v.edges.map((e) => [e.source, e.target, e.kind]),
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
