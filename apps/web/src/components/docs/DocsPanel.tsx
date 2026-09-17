"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { FileText, RefreshCw, Sparkles } from "lucide-react";
import { api, DOC_KINDS, type Doc } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { Markdown } from "@/components/Markdown";
import { ErrorBox, Spinner } from "@/components/ui";

export function DocsPanel() {
  const { repo } = useRepo();
  const list = useApi(`docs:${repo.id}`, () => api.docs.list(repo.id));
  const [active, setActive] = useState<Doc | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active && list.data && list.data.length > 0) {
      api.docs.get(repo.id, list.data[0].id).then(setActive);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  const generate = async (kinds?: string[]) => {
    setGenerating(true);
    setError(null);
    try {
      await api.docs.generate(repo.id, kinds);
      setActive(null);
      list.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const openDoc = async (d: Doc) => setActive(await api.docs.get(repo.id, d.id));
  const grouped = new Map<string, Doc[]>();
  for (const d of list.data ?? []) grouped.set(d.kind, [...(grouped.get(d.kind) ?? []), d]);

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-72 shrink-0 border-r border-line bg-elev flex flex-col">
        <div className="p-3 border-b border-line">
          <button className="btn btn-primary w-full text-xs" onClick={() => generate()} disabled={generating}>
            {generating ? <Spinner className="h-3 w-3 border-t-[#08111f]" /> : <RefreshCw size={13} />} {list.data?.length ? "Regenerate all" : "Generate documentation"}
          </button>
          <p className="text-[11px] text-faint mt-2">Architecture, API, modules, data flow, database, dependencies, setup, onboarding. Structural docs always; narrative sections need an LLM key.</p>
        </div>
        <div className="overflow-y-auto flex-1">
          {DOC_KINDS.map((kind) => {
            const docs = grouped.get(kind) ?? [];
            return (
              <div key={kind} className="border-b border-line/60">
                <div className="flex items-center justify-between px-3 pt-2 pb-1">
                  <span className="stat-label">{kind}</span>
                  <button className="text-[11px] text-faint hover:text-accent" onClick={() => generate([kind])} disabled={generating} title={`Regenerate ${kind}`}>↻</button>
                </div>
                {docs.length === 0 && <div className="px-3 pb-2 text-xs text-faint">not generated</div>}
                {docs.map((d) => (
                  <button key={d.id} onClick={() => openDoc(d)} className={clsx("w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-elev2", active?.id === d.id ? "bg-elev2 text-fg" : "text-muted")}>
                    <FileText size={12} className="shrink-0" />
                    <span className="truncate">{d.subject || d.title}</span>
                    {d.ai && <Sparkles size={11} className="text-accent shrink-0 ml-auto" />}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </aside>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-8 py-6">
          {error && <ErrorBox>{error}</ErrorBox>}
          {generating && <div className="flex items-center gap-2 text-muted text-sm mb-4"><Spinner /> Generating documentation from the code graph…</div>}
          {!active && !generating && (list.data?.length ?? 0) === 0 && (
            <div className="text-muted text-sm mt-10">No documentation yet. Click <b>Generate documentation</b> to build it from the code graph.</div>
          )}
          {active && (
            <>
              <div className="flex items-center gap-2 mb-4 text-xs text-faint">
                <span className="chip">{active.kind}</span>
                {active.ai ? <span className="chip text-accent"><Sparkles size={11} /> AI narrative</span> : <span className="chip">structural only</span>}
                <span>{new Date(active.created_at).toLocaleString()}</span>
              </div>
              <Markdown>{active.content ?? ""}</Markdown>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
