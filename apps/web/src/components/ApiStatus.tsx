"use client";

import { api, API_URL } from "@/lib/api";
import { useApi } from "@/lib/hooks";

/**
 * Stays out of sight while everything works; speaks up only when the API is unreachable or no AI
 * provider is configured (the AI features would fail without saying why).
 */
export function ApiStatus() {
  const { data, error } = useApi("health", () => api.health(), { pollMs: 15000 });
  if (error)
    return (
      <span className="chip border-danger/40 text-danger" title={`${API_URL}: ${error}`}>
        <span className="h-1.5 w-1.5 rounded-full bg-danger" /> API offline
      </span>
    );
  if (data && !data.llm_configured)
    return (
      <span className="chip border-warn/40 text-warn" title="No AI key is configured on the server, so AI answers are turned off">
        AI off
      </span>
    );
  return null;
}
