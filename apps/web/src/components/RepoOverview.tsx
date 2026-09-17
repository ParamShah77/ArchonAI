"use client";

import Link from "next/link";
import { RefreshCw, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { Empty, ErrorBox, Section, Spinner, Stat } from "@/components/ui";

const LAYER_COLOR: Record<string, string> = {
  interface: "#ffb86c",
  application: "#7ee0a0",
  data: "#ff7b9c",
  shared: "#8b93a7",
  frontend: "#5aa9ff",
  entry: "#e6db74",
  tests: "#4ec9b0",
  docs: "#6b7385",
  unclassified: "#3a4152",
};

function StackRow({ label, items }: { label: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex items-start gap-3">
      <div className="stat-label w-28 shrink-0 pt-1">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) => (
          <span key={i} className="chip">{i}</span>
        ))}
      </div>
    </div>
  );
}

export function RepoOverview() {
  const { repo } = useRepo();
  const arch = useApi(`arch:${repo.id}:${repo.updated_at}`, () => api.graph.architecture(repo.id));
  const st = repo.stats;
  const stack = repo.stack;

  return (
    <div className="p-6 space-y-6 max-w-7xl w-full mx-auto">
      <div className="flex flex-wrap gap-3">
        <Stat label="Files" value={st.files ?? 0} />
        <Stat label="Lines" value={(st.lines ?? 0).toLocaleString()} />
        <Stat label="Functions" value={((st.node_function as number) ?? 0) + ((st.node_method as number) ?? 0)} />
        <Stat label="Classes" value={(st.node_class as number) ?? 0} />
        <Stat label="Endpoints" value={(st.node_endpoint as number) ?? 0} />
        <Stat label="Tables" value={(st.node_table as number) ?? 0} />
        <Stat label="Dependencies" value={stack.dependency_count ?? 0} />
        <Stat label="Graph" value={`${st.nodes ?? 0} / ${st.edges ?? 0}`} hint="nodes / edges" />
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Section title="Technology stack">
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="stat-label w-28 shrink-0 pt-1">Languages</div>
              <div className="flex-1">
                <div className="flex h-2 rounded overflow-hidden bg-elev2">
                  {stack.languages?.map((l, i) => (
                    <div key={l.name} title={`${l.name}: ${l.files} files`} style={{ width: `${l.share * 100}%`, background: ["#5aa9ff", "#7ee0a0", "#c792ea", "#ffb86c", "#ff7b9c", "#e6db74"][i % 6] }} />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs text-muted">
                  {stack.languages?.map((l) => (
                    <span key={l.name}>{l.name} <span className="text-faint">{Math.round(l.share * 100)}%</span></span>
                  ))}
                </div>
              </div>
            </div>
            <StackRow label="Frameworks" items={stack.frameworks} />
            <StackRow label="Databases" items={stack.databases} />
            <StackRow label="Auth" items={stack.auth} />
            <StackRow label="Infra" items={stack.infra} />
            <StackRow label="CI" items={stack.ci} />
            <StackRow label="AI" items={stack.ai} />
            <StackRow label="Testing" items={stack.testing} />
            <StackRow label="Tooling" items={stack.tooling} />
            <StackRow label="Packages" items={stack.package_managers} />
          </div>
        </Section>

        <Section title="Components" action={<Link href={`/repos/${repo.id}/map`} className="btn btn-ghost text-xs">Open map →</Link>}>
          {arch.loading && !arch.data ? (
            <div className="flex items-center gap-2 text-muted"><Spinner /> Reconstructing…</div>
          ) : arch.error ? (
            <ErrorBox>{arch.error}</ErrorBox>
          ) : arch.data && arch.data.components.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-faint text-[11px] uppercase tracking-wider">
                  <tr><th className="pb-2">Component</th><th className="pb-2">Layer</th><th className="pb-2 text-right">Files</th><th className="pb-2 text-right">Fns</th><th className="pb-2 text-right">API</th><th className="pb-2 text-right">Tables</th></tr>
                </thead>
                <tbody className="mono">
                  {arch.data.components.slice(0, 14).map((c) => (
                    <tr key={c.name} className="border-t border-line">
                      <td className="py-1.5">
                        <Link href={`/repos/${repo.id}/map?prefix=${encodeURIComponent(c.name === "(root)" ? "" : c.name)}`} className="hover:text-accent">{c.name}</Link>
                      </td>
                      <td className="py-1.5"><span className="chip" style={{ color: LAYER_COLOR[c.layer], borderColor: `${LAYER_COLOR[c.layer]}55` }}>{c.layer}</span></td>
                      <td className="py-1.5 text-right">{c.files}</td>
                      <td className="py-1.5 text-right">{c.functions}</td>
                      <td className="py-1.5 text-right">{c.endpoints}</td>
                      <td className="py-1.5 text-right">{c.tables}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No components detected.</Empty>
          )}
        </Section>
      </div>

      <Section
        title="Architecture reconstruction"
        action={
          <button className="btn btn-ghost text-xs" onClick={() => api.graph.architecture(repo.id, true).then((d) => arch.setData(d))} disabled={arch.loading}>
            <RefreshCw size={14} /> Regenerate
          </button>
        }
      >
        {arch.loading && !arch.data ? (
          <div className="flex items-center gap-2 text-muted"><Spinner /> Analyzing structure…</div>
        ) : arch.data?.ai ? (
          <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6">
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-xs text-accent"><Sparkles size={14} /> {arch.data.ai.architecture_style}</div>
              <p className="leading-relaxed">{arch.data.ai.summary}</p>
              <div>
                <div className="stat-label mb-2">Components</div>
                <ul className="space-y-1.5">
                  {arch.data.ai.components.map((c) => (
                    <li key={c.name} className="flex gap-2 text-sm">
                      <span className="h-2 w-2 mt-1.5 rounded-full shrink-0" style={{ background: LAYER_COLOR[c.layer] ?? "#8b93a7" }} />
                      <span><span className="mono font-medium">{c.name}</span> <span className="text-muted">— {c.responsibility}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <div className="stat-label mb-2">Data flow</div>
                <ol className="space-y-1 list-decimal list-inside text-sm text-muted">
                  {arch.data.ai.data_flow.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </div>
              {arch.data.ai.external_systems?.length > 0 && (
                <div>
                  <div className="stat-label mb-2">External systems</div>
                  <div className="flex flex-wrap gap-1.5">{arch.data.ai.external_systems.map((s) => <span key={s} className="chip">{s}</span>)}</div>
                </div>
              )}
              {arch.data.ai.risks?.length > 0 && (
                <div>
                  <div className="stat-label mb-2">Risks</div>
                  <ul className="space-y-1 text-sm text-warn">{arch.data.ai.risks.map((r, i) => <li key={i}>• {r}</li>)}</ul>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {arch.data?.ai_error && <div className="text-sm text-warn">{arch.data.ai_error}</div>}
            {arch.data && (
              <div className="grid md:grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="stat-label mb-2">Entry points</div>
                  <ul className="mono text-xs space-y-1 text-muted">{arch.data.entry_points.slice(0, 10).map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
                <div>
                  <div className="stat-label mb-2">Endpoints ({arch.data.endpoint_count})</div>
                  <ul className="mono text-xs space-y-1 text-muted">{arch.data.endpoints.slice(0, 10).map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
                <div>
                  <div className="stat-label mb-2">Tables</div>
                  <ul className="mono text-xs space-y-1 text-muted">{arch.data.tables.slice(0, 10).map((p) => <li key={p}>{p}</li>)}</ul>
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      {arch.data && (
        <div className="grid lg:grid-cols-3 gap-6">
          <Section title="Most imported files">
            <ul className="mono text-xs space-y-1.5">
              {arch.data.metrics.most_imported.map((m) => (
                <li key={m.path} className="flex justify-between gap-2"><span className="truncate text-muted">{m.path}</span><span className="text-accent">{m.fan_in}</span></li>
              ))}
              {arch.data.metrics.most_imported.length === 0 && <Empty>None</Empty>}
            </ul>
          </Section>
          <Section title="Heaviest importers">
            <ul className="mono text-xs space-y-1.5">
              {arch.data.metrics.most_importing.map((m) => (
                <li key={m.path} className="flex justify-between gap-2"><span className="truncate text-muted">{m.path}</span><span className="text-accent">{m.fan_out}</span></li>
              ))}
              {arch.data.metrics.most_importing.length === 0 && <Empty>None</Empty>}
            </ul>
          </Section>
          <Section title={`Import cycles (${arch.data.metrics.import_cycles.length})`}>
            {arch.data.metrics.import_cycles.length === 0 ? (
              <div className="text-sm text-ok">No import cycles detected.</div>
            ) : (
              <ul className="mono text-xs space-y-2">
                {arch.data.metrics.import_cycles.slice(0, 8).map((c, i) => (
                  <li key={i} className="text-warn break-all">{c.join(" → ")} → {c[0]}</li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {Array.isArray(st.parse_errors) && st.parse_errors.length > 0 && (
        <Section title={`Parse warnings (${st.parse_errors.length})`}>
          <ul className="mono text-xs text-warn space-y-1">{st.parse_errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}
