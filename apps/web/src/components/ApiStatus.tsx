"use client";

import { api, API_URL } from "@/lib/api";
import { useApi } from "@/lib/hooks";

export function ApiStatus() {
  const { data, error } = useApi("health", () => api.health(), { pollMs: 15000 });
  if (error)
    return (
      <span className="chip border-danger/40 text-danger" title={`${API_URL}: ${error}`}>
        <span className="h-1.5 w-1.5 rounded-full bg-danger" /> API offline
      </span>
    );
  if (!data) return <span className="chip"><span className="h-1.5 w-1.5 rounded-full bg-faint pulse" /> connecting</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="chip" title={`database: ${data.database}`}>
        <span className="h-1.5 w-1.5 rounded-full bg-ok" /> API v{data.version}
      </span>
      <span
        className={`chip ${data.llm_configured ? "" : "border-warn/40 text-warn"}`}
        title={
          data.llm_configured
            ? `Fallback chain (tried in order):\n${data.llm_chain
                .map((l, i) => `${i + 1}. ${l.link}  ok ${l.ok} · failed ${l.failed}${l.cooling_down ? " · cooling down" : ""}`)
                .join("\n")}\nEmbeddings: ${data.embeddings ? "on" : "off"}`
            : "No LLM key configured — AI features disabled"
        }
      >
        LLM: {data.llm_configured ? `${data.llm_provider}${data.llm_chain.length > 1 ? ` +${data.llm_chain.length - 1}` : ""}` : "off"}
      </span>
    </span>
  );
}
