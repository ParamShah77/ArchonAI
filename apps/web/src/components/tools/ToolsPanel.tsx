"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { History, Trash2 } from "lucide-react";
import { api, type AIResult, type GraphNode, type ToolRunInfo } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { timeAgo } from "@/lib/time";
import { useRepo } from "@/components/RepoShell";
import { JsonView } from "@/components/JsonView";
import { Sources } from "@/components/chat/ChatPanel";
import { ErrorBox, KindBadge, Section, Spinner } from "@/components/ui";

import { TOOLS } from "./toolList";
type ToolId = (typeof TOOLS)[number]["id"];

export function ToolsPanel() {
  const sp = useSearchParams();
  const router = useRouter();
  const { repo } = useRepo();
  const tool = (sp.get("tool") as ToolId) || "debug";
  const setTool = (t: ToolId) => router.replace(`/repos/${repo.id}/tools?tool=${t}`);
  const meta = TOOLS.find((t) => t.id === tool) ?? TOOLS[0];
  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-60 shrink-0 border-r border-line bg-elev overflow-y-auto">
        {TOOLS.map((t) => (
          <button key={t.id} onClick={() => setTool(t.id)} className={clsx("w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 border-b border-line/60 hover:bg-elev2", tool === t.id ? "bg-elev2 text-fg" : "text-muted")}>
            <t.icon size={15} className={tool === t.id ? "text-accent" : ""} /> {t.label}
          </button>
        ))}
      </aside>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2"><meta.icon size={18} className="text-accent" /> {meta.label}</h2>
            <p className="text-muted text-sm mt-1">{meta.blurb}</p>
          </div>
          <ToolForm key={tool} tool={tool} />
        </div>
      </div>
    </div>
  );
}

function useRun() {
  const [result, setResult] = useState<AIResult | null>(null);
  const [done, setDone] = useState(0); // bumps after every finished run (refreshes the history)
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<AIResult>) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await fn());
      setDone((d) => d + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { result, error, busy, run, done, setResult };
}

function NodePicker({ value, onChange, kinds }: { value: GraphNode | null; onChange: (n: GraphNode | null) => void; kinds?: string }) {
  const { repo } = useRepo();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [hits, setHits] = useState<GraphNode[]>([]);
  useEffect(() => {
    if (dq.length < 2) return;
    let cancelled = false;
    api.graph.search(repo.id, dq, kinds).then((r) => { if (!cancelled) setHits(r.results); });
    return () => { cancelled = true; };
  }, [dq, repo.id, kinds]);
  const showHits = dq.length >= 2 && hits.length > 0;
  if (value)
    return (
      <div className="flex items-center gap-2 card px-3 py-2">
        <KindBadge kind={value.kind} />
        <span className="mono text-sm">{value.kind === "method" && value.meta.class ? `${value.meta.class}.` : ""}{value.name}</span>
        <span className="text-faint text-xs truncate">{value.path}:{value.start_line}</span>
        <button className="btn btn-ghost text-xs ml-auto" onClick={() => onChange(null)}>change</button>
      </div>
    );
  return (
    <div className="relative">
      <input className="input" placeholder="Search a function, class, file, endpoint or table…" value={q} onChange={(e) => setQ(e.target.value)} />
      {showHits && (
        <div className="absolute z-20 mt-1 w-full card shadow-xl max-h-72 overflow-y-auto">
          {hits.map((n) => (
            <button key={n.id} className="w-full text-left px-3 py-1.5 hover:bg-elev2 flex items-center gap-2 text-xs" onClick={() => { onChange(n); setQ(""); setHits([]); }}>
              <KindBadge kind={n.kind} /> <span className="mono">{n.kind === "method" && n.meta.class ? `${n.meta.class}.` : ""}{n.name}</span> <span className="text-faint truncate ml-auto">{n.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Result({ r, factsTitle = "Structural analysis", facts }: { r: AIResult | null; factsTitle?: string; facts?: ReactNode }) {
  const { repo } = useRepo();
  if (!r) return null;
  return (
    <div className="space-y-4">
      {r.ai_error && !r.ai && <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">AI step unavailable: {r.ai_error}. The structural analysis below is still exact.</div>}
      {r.ai && (
        <Section title="AI analysis" action={r.ai_model ? <span className="text-[11px] text-faint mono">{r.ai_model}</span> : undefined}>
          <JsonView data={r.ai} />
        </Section>
      )}
      <Section title={factsTitle}>{facts ?? <JsonView data={r.facts ?? r} />}</Section>
      {Array.isArray(r.sources) && r.sources.length > 0 && <Section title="Sources used"><Sources repoId={repo.id} sources={r.sources} /></Section>}
    </div>
  );
}

function RunButton({ busy, label, disabled }: { busy: boolean; label: string; disabled?: boolean }) {
  return <button className="btn btn-primary" disabled={busy || disabled}>{busy ? <Spinner className="h-3.5 w-3.5 border-t-[#08111f]" /> : null} {busy ? "Analyzing…" : label}</button>;
}

function ToolForm({ tool }: { tool: ToolId }) {
  const { repo } = useRepo();
  const sp = useSearchParams();
  const { result, error, busy, run, done, setResult } = useRun();
  const [text, setText] = useState("");
  const [extra, setExtra] = useState("");
  const [node, setNode] = useState<GraphNode | null>(null);
  const [depth, setDepth] = useState(3);
  const [withAi, setWithAi] = useState(true);

  // deep link: /tools?tool=tests&node=<id> or tool=impact&node=<id>
  useEffect(() => {
    const nid = sp.get("node");
    if (nid && !node) api.graph.node(repo.id, nid).then((d) => setNode(d.node)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    switch (tool) {
      case "debug": return run(() => api.tools.debug(repo.id, text, extra));
      case "impact": return node && run(() => api.tools.impact(repo.id, { node_id: node.id, depth, change: extra, ai: withAi }));
      case "feature": return run(() => api.tools.feature(repo.id, text, "simulate"));
      case "plan": return run(() => api.tools.feature(repo.id, text, "plan"));
      case "advise": return run(() => api.tools.advise(repo.id, text));
      case "refactor": return run(() => api.tools.refactor(repo.id, node ? { node_id: node.id } : {}));
      case "tests": return node && run(() => api.tools.tests(repo.id, node.id));
      case "review": return run(() => api.tools.review(repo.id, text, extra));
      case "logs": return run(() => api.tools.logs(repo.id, text, extra));
    }
  };

  const textArea = (placeholder: string, rows = 8) => (
    <textarea className="input mono text-xs" rows={rows} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
  );
  const extraInput = (placeholder: string) => <input className="input" placeholder={placeholder} value={extra} onChange={(e) => setExtra(e.target.value)} />;

  return (
    <div className="space-y-5">
      <form onSubmit={submit} className="card p-4 space-y-3">
        {tool === "debug" && <>{textArea("Paste the error, stack trace, or failing log lines…", 10)}{extraInput("What did you expect to happen? (optional)")}</>}
        {(tool === "feature" || tool === "plan") && textArea(tool === "feature" ? "Describe the feature, e.g. 'Let users cancel an order within 10 minutes of placing it; send an email on cancellation.'" : "Describe the requirement to plan, e.g. 'Add multi-tenant support with per-tenant data isolation.'", 5)}
        {tool === "advise" && textArea("e.g. What should I change to support 10× more users? How would I split this into services? Is the data layer a bottleneck?", 3)}
        {tool === "review" && <>{extraInput("Change title (optional)")}{textArea("Paste a unified diff (git diff / PR patch)…", 14)}</>}
        {tool === "logs" && <>{textArea("Paste application logs (with timestamps and levels if available)…", 12)}{extraInput("What were users experiencing? (optional)")}</>}
        {(tool === "impact" || tool === "tests" || tool === "refactor") && (
          <>
            <NodePicker value={node} onChange={setNode} kinds={tool === "tests" ? "function,method" : undefined} />
            {tool === "impact" && (
              <div className="flex items-center gap-3 flex-wrap">
                {extraInput("What do you plan to change? (optional, improves the AI summary)")}
                <label className="text-xs text-muted flex items-center gap-2">depth
                  <select className="input py-1 w-auto" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d}</option>)}</select>
                </label>
                <label className="text-xs text-muted flex items-center gap-1.5"><input type="checkbox" checked={withAi} onChange={(e) => setWithAi(e.target.checked)} /> AI summary</label>
              </div>
            )}
            {tool === "refactor" && <p className="text-xs text-faint">Leave empty to let ARCHON pick the hottest technical-debt spot from the last audit.</p>}
          </>
        )}
        <RunButton busy={busy} label={{ debug: "Find root cause", impact: "Analyze impact", feature: "Simulate feature", plan: "Create plan", advise: "Get recommendations", refactor: "Propose refactoring", tests: "Generate tests", review: "Review change", logs: "Analyze incident" }[tool]} disabled={(tool === "impact" || tool === "tests") && !node} />
      </form>
      <RecentRuns
        tool={tool}
        refreshKey={done}
        openId={(result?.run_id as string | undefined) ?? null}
        onOpen={(r) => {
          setResult(r.result);
          // put the question back in the form, so it can be edited and run again
          const i = r.inputs;
          const main = i.error ?? i.description ?? i.question ?? i.diff ?? i.logs;
          if (typeof main === "string") setText(main);
          const second = tool === "review" ? i.title : tool === "impact" ? i.change : i.description;
          if (typeof second === "string" && tool !== "feature" && tool !== "plan") setExtra(second);
          if (typeof i.node_id === "string") api.graph.node(repo.id, i.node_id).then((d) => setNode(d.node)).catch(() => {});
        }}
      />
      {error && <ErrorBox>{error}</ErrorBox>}
      {tool === "impact" && result ? <ImpactResult r={result} /> : tool === "review" && result ? <ReviewResult r={result} /> : tool === "logs" && result ? <LogsResult r={result} /> : <Result r={result} />}
    </div>
  );
}

/** Earlier runs of this tool on this repository (kept on the server, newest first). */
function RecentRuns({
  tool,
  refreshKey,
  openId,
  onOpen,
}: {
  tool: ToolId;
  refreshKey: number;
  openId: string | null;
  onOpen: (r: ToolRunInfo & { inputs: Record<string, unknown>; result: AIResult }) => void;
}) {
  const { repo } = useRepo();
  const [extra, setExtra] = useState(0);
  const { data: runs } = useApi(`tool-runs:${repo.id}:${tool}:${refreshKey}:${extra}`, () => api.tools.runs(repo.id, tool));
  const [all, setAll] = useState(false);
  if (!runs?.length) return null;
  const shown = all ? runs : runs.slice(0, 5);
  return (
    <div className="card px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted mb-1">
        <History size={13} /> Recent runs
        <span className="text-faint">· {runs.length}</span>
        {runs.length > 5 && (
          <button className="ml-auto text-faint hover:text-fg" onClick={() => setAll((a) => !a)}>{all ? "show fewer" : "show all"}</button>
        )}
      </div>
      <ul className="divide-y divide-line">
        {shown.map((r) => (
          <li key={r.id} className={clsx("group flex items-center gap-2 py-1 text-xs", r.id === openId && "text-accent")}>
            <button
              className="flex-1 min-w-0 text-left truncate hover:text-fg"
              title="Open this result"
              onClick={() => api.tools.run(repo.id, r.id).then(onOpen)}
            >
              {r.title || "(untitled)"}
            </button>
            <span className="text-faint shrink-0">{timeAgo(r.created_at)}</span>
            <button
              className="opacity-0 group-hover:opacity-100 text-faint hover:text-danger shrink-0"
              title="Forget this run"
              onClick={() => api.tools.removeRun(repo.id, r.id).then(() => setExtra((x) => x + 1))}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImpactResult({ r }: { r: AIResult }) {
  const { repo } = useRepo();
  const risk = r.risk as { score: number; level: string; reasons: string[] } | undefined;
  const up = r.upstream as Record<string, { id: string; name: string; kind: string; path: string; line: number; distance: number }[]> | undefined;
  const color = risk?.level === "critical" ? "#ff5c7a" : risk?.level === "high" ? "#ff7b9c" : risk?.level === "medium" ? "#ffb86c" : "#7ee0a0";
  return (
    <Result
      r={r}
      factsTitle="Blast radius"
      facts={
        <div className="space-y-4">
          {risk && (
            <div className="flex items-center gap-4">
              <div className="text-4xl font-semibold mono" style={{ color }}>{risk.score}</div>
              <div><div className="uppercase text-xs tracking-wider" style={{ color }}>{risk.level} risk</div><ul className="text-xs text-muted">{risk.reasons.map((x) => <li key={x}>• {x}</li>)}</ul></div>
            </div>
          )}
          {up && Object.entries(up).filter(([, v]) => v.length).map(([k, v]) => (
            <div key={k}>
              <div className="stat-label mb-1">{k} · {v.length}</div>
              <div className="flex flex-wrap gap-1.5">
                {v.slice(0, 60).map((n) => (
                  <a key={n.id} href={`/repos/${repo.id}/map?focus=${n.id}&node=${n.id}`} className="chip hover:border-accent mono" title={`${n.path}:${n.line} (distance ${n.distance})`}>{n.name}<span className="text-faint">·{n.distance < 0 ? "t" : n.distance}</span></a>
                ))}
                {v.length > 60 && <span className="text-faint text-xs">+{v.length - 60} more</span>}
              </div>
            </div>
          ))}
        </div>
      }
    />
  );
}

function ReviewResult({ r }: { r: AIResult }) {
  const quick = r.quick_findings as { path: string; line: number; severity: string; title: string; evidence: string; recommendation: string }[];
  const syms = r.changed_symbols as { name: string; path: string; risk: string; callers: number; endpoints: string[]; tests: string[] }[];
  return (
    <Result
      r={r}
      factsTitle="Structural review"
      facts={
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-2">{(r.files as { path: string; added: number; removed: number }[]).map((f) => <span key={f.path} className="chip mono">{f.path} <span className="text-ok">+{f.added}</span> <span className="text-danger">−{f.removed}</span></span>)}</div>
          {syms.length > 0 && <div><div className="stat-label mb-1">Changed symbols</div><ul className="space-y-1">{syms.map((s) => <li key={s.name + s.path} className="flex flex-wrap items-center gap-2"><span className="mono">{s.name}</span><span className="chip">{s.risk} risk</span><span className="text-faint text-xs">{s.callers} callers · endpoints: {s.endpoints.join(", ") || "—"} · tests: {s.tests.length}</span></li>)}</ul></div>}
          {quick.length > 0 && <div><div className="stat-label mb-1">Rule checks on added lines</div><ul className="space-y-1.5">{quick.map((q, i) => <li key={i}><span className="chip">{q.severity}</span> <span>{q.title}</span> <span className="text-faint text-xs mono">{q.path}:{q.line}</span><pre className="mono text-[11px] text-muted mt-0.5">{q.evidence}</pre></li>)}</ul></div>}
          {quick.length === 0 && syms.length === 0 && <span className="text-faint">No rule hits; changed lines did not intersect known symbols.</span>}
        </div>
      }
    />
  );
}

function LogsResult({ r }: { r: AIResult }) {
  const f = r.facts as { entries: number; levels: Record<string, number>; clusters: { template: string; count: number; levels: Record<string, number> }[]; bursts: { minute: string; errors: number }[]; code_refs: { path: string; line: number; node: string }[]; timeline: Record<string, number | string>[] };
  return (
    <Result
      r={r}
      factsTitle="Log analysis"
      facts={
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap gap-2">{Object.entries(f.levels).map(([k, v]) => <span key={k} className="chip">{k} {v}</span>)}<span className="chip">{f.entries} lines</span>{f.bursts.map((b) => <span key={b.minute} className="chip text-danger">burst {b.minute} · {b.errors} errors</span>)}</div>
          {f.timeline.length > 1 && (
            <div className="flex items-end gap-px h-16" title="errors per minute">
              {f.timeline.slice(0, 200).map((t, i) => { const e = Number(t.ERROR ?? 0) + Number(t.CRITICAL ?? 0); const tot = Object.entries(t).filter(([k]) => k !== "minute").reduce((a, [, v]) => a + Number(v), 0); return <div key={i} className="flex-1 min-w-[3px] rounded-t" style={{ height: `${Math.min(100, 10 + tot * 6)}%`, background: e ? "#ff7b9c" : "#3a4152" }} title={`${t.minute}: ${tot} lines, ${e} errors`} />; })}
            </div>
          )}
          <div><div className="stat-label mb-1">Message clusters</div><ul className="space-y-1">{f.clusters.slice(0, 15).map((c) => <li key={c.template} className="flex gap-2"><span className="chip mono w-12 justify-center">{c.count}</span><span className={clsx("mono text-xs", c.levels.ERROR || c.levels.CRITICAL ? "text-danger" : "text-muted")}>{c.template}</span></li>)}</ul></div>
          {f.code_refs.length > 0 && <div><div className="stat-label mb-1">Code referenced</div><ul className="mono text-xs space-y-0.5">{f.code_refs.map((c, i) => <li key={i}>{c.path}:{c.line} <span className="text-accent">{c.node}</span></li>)}</ul></div>}
        </div>
      }
    />
  );
}
