"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  /** Poll interval in ms; return 0 from `pollWhile` to stop. */
  pollMs?: number;
  pollWhile?: (data: unknown) => boolean;
  enabled?: boolean;
}

/**
 * Minimal data hook: fetch on mount / when `key` changes, optional polling, manual refresh.
 * Deliberately small so the app has no data-fetching dependency (decisions.md D-009).
 */
export function useApi<T>(key: string | null, fetcher: () => Promise<T>, opts: Options = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const fetcherRef = useRef(fetcher);
  const optsRef = useRef(opts);
  const [tick, setTick] = useState(0);
  const enabled = !!key && opts.enabled !== false;

  // Keep the latest callbacks available to the polling loop without re-running it.
  useEffect(() => {
    fetcherRef.current = fetcher;
    optsRef.current = opts;
  });

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const d = await fetcherRef.current();
        if (cancelled) return;
        setData(d);
        setError(null);
        const o = optsRef.current;
        if (o.pollMs && (!o.pollWhile || o.pollWhile(d))) timer = setTimeout(run, o.pollMs);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadedKey(key);
      }
    };
    run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, tick, enabled]);

  // "loading" means: enabled and nothing has been fetched yet for this key (polling/refresh keep stale data).
  return { data, error, loading: enabled && loadedKey !== key, refresh, setData };
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
