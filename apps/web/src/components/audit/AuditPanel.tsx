"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, ChevronRight, EyeOff, Play, RotateCcw } from "lucide-react";
import { api, SEVERITY_COLOR, type Finding, type Severity } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { Empty, ErrorBox, Section, Spinner } from "@/components/ui";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const ANALYZER_LABEL: Record<string, string> = { security: "Security", performance: "Performance", debt: "Tech debt", dependency: "Dependencies", api: "API", database: "Database", tests: "Tests" };

export function AuditPanel() {
  const { repo } = useRepo();
  const runs = useApi(`runs:${repo.id}`, () => api.analysis.runs(repo.id), { pollMs: 1500, pollWhile: (r) => Array.isArray(r) && r.some((x) => x.status === "pending" || x.status === "running") });
  const latest = runs.data?.[0];
  const runningKey = latest && (latest.status === "pending" || latest.status === "running") ? "running" : latest?.id ?? "none";
  const [analyzer, setAnalyzer] = useState<string>("");
  const [severity, setSeverity] = useState<Set<Severity>>(new Set(SEVERITIES));
  const [status, setStatus] = useState("open");
  const findings = useApi(`findings:${repo.id}:${runningKey}:${analyzer}:${status}`, () => api.analysis.findings(repo.id, { analyzer: analyzer || undefined, status }));
  const health = useApi(`health:${repo.id}:${runningKey}`, () => api.analysis.health(repo.id));
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const start = async () => {
    setStarting(true);
    try {
      await api.analysis.run(repo.id);
      runs.refresh();
    } finally {
      setStarting(false);
    }
  };

  const visible = useMemo(() => (findings.data?.findings ?? []).filter((f) => severity.has(f.severity)), [findings.data, severity]);
  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const [a, sevs] of Object.entries(findings.data?.summary ?? {})) t[a] = Object.values(sevs).reduce((x, y) => x + y, 0);
    return t;
  }, [findings.data]);

  const setFindingStatus = async (f: Finding, s: string) => {
    await api.analysis.setStatus(repo.id, f.id, s);
    findings.refresh();
    health.refresh();
  };

  const busy = latest?.status === "pending" || latest?.status === "running";
  const h = health.data?.current;

  return (
    <div className="p-6 space-y-6 max-w-7xl w-full mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <button className="btn btn-primary" onClick={start} disabled={busy || starting}>
          {busy || starting ? <Spinner className="h-3.5 w-3.5 border-t-[#08111f]" /> : <Play size={15} />} {busy ? "Analyzing…" : "Run all analyzers"}
        </button>
        {latest && (
          <span className="text-xs text-muted">
            Last run: <span className={clsx(latest.status === "failed" ? "text-danger" : latest.status === "done" ? "text-ok" : "text-accent")}>{latest.status}</span>
            {latest.finished_at && ` · ${new Date(latest.finished_at).toLocaleString()}`}
            {latest.error && <span className="text-danger"> · {latest.error}</span>}
          </span>
        )}
        {!latest && runs.data && <span className="text-xs text-muted">No analysis has run yet. Findings, health score and reports appear after the first run.</span>}
      </div>

      {h && (
        <div className="grid lg:grid-cols-[260px_1fr] gap-6">
          <div className="card p-5 flex flex-col items-center justify-center">
            <div className="stat-label">Engineering health</div>
            <div className="text-5xl font-semibold mono mt-2" style={{ color: h.score >= 75 ? "#7ee0a0" : h.score >= 55 ? "#ffb86c" : "#ff7b9c" }}>{h.score}</div>
            <div className="text-muted text-sm">grade {h.grade} · {h.findings_total} findings · {h.kloc} KLOC</div>
            {health.data && health.data.history.length > 1 && (
              <div className="mt-3 flex items-end gap-0.5 h-10" title="score history">
                {health.data.history.map((p, i) => (
                  <div key={i} className="w-2 rounded-sm bg-accent/60" style={{ height: `${Math.max(4, p.score)}%` }} title={`${p.score} ${p.created_at ? new Date(p.created_at).toLocaleDateString() : ""}`} />
                ))}
              </div>
            )}
          </div>
          <Section title="Dimensions" action={<button className="btn btn-ghost text-xs" onClick={() => api.analysis.health(repo.id, true).then(() => health.refresh())}><RotateCcw size={13} /> Recompute</button>}>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2">
              {Object.entries(h.dimensions).map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 text-sm">
                  <div className="w-32 capitalize text-muted">{k}</div>
                  <div className="flex-1 h-2 rounded bg-elev2 overflow-hidden"><div className="h-full rounded" style={{ width: `${v}%`, background: v >= 75 ? "#7ee0a0" : v >= 55 ? "#ffb86c" : "#ff7b9c" }} /></div>
                  <div className="w-10 text-right mono">{Math.round(v)}</div>
                  <div className="w-10 text-right text-faint text-xs">×{Math.round((h.weights[k] ?? 0) * 100)}%</div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      <Section
        title={`Findings ${findings.data ? `(${visible.length})` : ""}`}
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <select className="input py-1 w-auto text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="open">open</option><option value="resolved">resolved</option><option value="dismissed">dismissed</option><option value="all">all</option>
            </select>
            {SEVERITIES.map((s) => (
              <button key={s} className={clsx("chip", !severity.has(s) && "opacity-40")} style={{ color: SEVERITY_COLOR[s], borderColor: `${SEVERITY_COLOR[s]}55` }} onClick={() => setSeverity((set) => { const n = new Set(set); if (n.has(s)) n.delete(s); else n.add(s); return n; })}>
                {s}
              </button>
            ))}
          </div>
        }
      >
        <div className="flex gap-1.5 flex-wrap mb-4">
          <button className={clsx("chip", analyzer === "" && "text-accent border-accent/50")} onClick={() => setAnalyzer("")}>All</button>
          {Object.entries(ANALYZER_LABEL).map(([k, label]) => (
            <button key={k} className={clsx("chip", analyzer === k && "text-accent border-accent/50")} onClick={() => setAnalyzer(k)}>
              {label} {totals[k] ? <span className="text-faint">{totals[k]}</span> : null}
            </button>
          ))}
        </div>
        {findings.error && <ErrorBox>{findings.error}</ErrorBox>}
        {findings.loading && !findings.data && <div className="flex items-center gap-2 text-muted text-sm"><Spinner /> Loading…</div>}
        {findings.data && visible.length === 0 && <Empty>No findings match the current filters.</Empty>}
        <ul className="divide-y divide-line">
          {visible.map((f) => (
            <li key={f.id}>
              <button className="w-full text-left py-2.5 flex items-start gap-3 hover:bg-elev2/50 px-2 -mx-2 rounded" onClick={() => setOpen(open === f.id ? null : f.id)}>
                {open === f.id ? <ChevronDown size={14} className="mt-1 text-faint shrink-0" /> : <ChevronRight size={14} className="mt-1 text-faint shrink-0" />}
                <span className="chip shrink-0 w-[74px] justify-center" style={{ color: SEVERITY_COLOR[f.severity], borderColor: `${SEVERITY_COLOR[f.severity]}55` }}>{f.severity}</span>
                <span className="chip shrink-0">{ANALYZER_LABEL[f.analyzer] ?? f.analyzer}</span>
                <span className="text-sm flex-1 min-w-0">
                  <span className={clsx(f.status !== "open" && "line-through text-faint")}>{f.title}</span>
                  {f.path && <span className="block text-xs text-faint mono truncate">{f.path}{f.start_line ? `:${f.start_line}` : ""}</span>}
                </span>
                <span className="text-xs text-faint shrink-0">{Math.round(f.confidence * 100)}%</span>
              </button>
              {open === f.id && (
                <div className="ml-9 mb-4 mr-2 space-y-2 text-sm">
                  {f.description && <p className="text-muted">{f.description}</p>}
                  {f.evidence && <pre className="mono text-[11px] bg-bg border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap">{f.evidence}</pre>}
                  {f.recommendation && <p><span className="text-ok">Recommendation:</span> {f.recommendation}</p>}
                  <div className="flex items-center gap-2 pt-1">
                    {f.node_id && <Link href={`/repos/${repo.id}/map?focus=${f.node_id}&node=${f.node_id}&depth=1`} className="btn btn-ghost text-xs">Open in map</Link>}
                    {f.status === "open" ? (
                      <>
                        <button className="btn btn-ghost text-xs" onClick={() => setFindingStatus(f, "resolved")}><Check size={13} /> Resolved</button>
                        <button className="btn btn-ghost text-xs" onClick={() => setFindingStatus(f, "dismissed")}><EyeOff size={13} /> Dismiss</button>
                      </>
                    ) : (
                      <button className="btn btn-ghost text-xs" onClick={() => setFindingStatus(f, "open")}>Reopen</button>
                    )}
                    <span className="text-faint text-xs ml-auto">{f.category} · {f.tags.join(", ")}</span>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
