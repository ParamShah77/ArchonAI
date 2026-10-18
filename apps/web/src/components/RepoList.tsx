"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  Ellipsis,
  FileCode2,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  Map as MapIcon,
  MessageSquare,
  Network,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { api, SEVERITY_COLOR, type Repo, type Severity } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ErrorBox, Spinner, StatusPill } from "@/components/ui";

const busy = (r: Repo) => r.status === "pending" || r.status === "ingesting";
const anyBusy = (repos: unknown) => Array.isArray(repos) && repos.some(busy);
const isGit = (s: string) => /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(s.trim());

/** The API stores UTC without a zone suffix; read it as UTC. */
function parseUtc(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}
export function timeAgo(d: Date | null): string {
  if (!d) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [[60, "min"], [3600, "h"], [86400, "d"], [604800, "w"], [2629800, "mo"], [31557600, "y"]];
  let i = 0;
  while (i + 1 < units.length && s >= units[i + 1][0]) i++;
  return `${Math.floor(s / units[i][0])} ${units[i][1]} ago`;
}
/** `github.com/org/repo` for remotes; `~\Desktop\x` for folders under the user's home. */
function shortSource(src: string): string {
  if (isGit(src)) return src.replace(/^(https?:\/\/|ssh:\/\/|git:\/\/)([^@/]*@)?/i, "").replace(/^git@([^:]+):/i, "$1/").replace(/\.git$/i, "").replace(/\/$/, "");
  return src.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "~").replace(/^\/(home|Users)\/[^/]+/, "~");
}

// GitHub's language colours, so the bars look familiar
const LANG_COLOR: Record<string, string> = {
  python: "#3572A5", typescript: "#3178c6", javascript: "#f1e05a", go: "#00ADD8", java: "#b07219", rust: "#dea584",
  ruby: "#701516", php: "#4F5D95", csharp: "#178600", "c#": "#178600", cpp: "#f34b7d", "c++": "#f34b7d", c: "#555555",
  kotlin: "#A97BFF", swift: "#F05138", html: "#e34c26", css: "#663399", scss: "#c6538c", vue: "#41b883", sql: "#e38c00",
  shell: "#89e051", dart: "#00B4AB", scala: "#c22d40",
};
const langColor = (name: string) => LANG_COLOR[name.toLowerCase()] ?? "#8b93a7";
const GRADE_COLOR: Record<string, string> = { A: "var(--ok)", B: "#b5e08a", C: "var(--warn)", D: "#ff9b7a", E: "var(--danger)", F: "var(--danger)" };

export function RepoList() {
  const { data: repos, error, loading, refresh } = useApi("repos", () => api.repos.list(), { pollMs: 1500, pollWhile: anyBusy });
  const [source, setSource] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const src = source.trim();
    if (!src) return;
    setSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    try {
      const r = await api.repos.create(src);
      setSource("");
      // the API returns the existing entry when this repository was already added (any spelling)
      if (repos?.some((x) => x.id === r.id)) setNotice(`"${r.name}" is already here — refreshing it with the latest code.`);
      refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!repos || !t) return repos ?? [];
    return repos.filter((r) => [r.name, r.source, r.stack?.primary_language, ...(r.stack?.frameworks ?? [])].some((v) => v?.toLowerCase().includes(t)));
  }, [repos, q]);

  return (
    <div className="space-y-8">
      {/* add a repository: the one thing to do first */}
      <form onSubmit={submit} className="card p-5 bg-gradient-to-br from-elev to-elev2/60">
        <div className="flex items-baseline justify-between gap-4 mb-3">
          <label htmlFor="repo-source" className="font-medium">Analyze a repository</label>
          <span className="text-xs text-faint hidden sm:inline">Git URLs are cloned into the workspace · local folders are read in place, never modified</span>
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-faint">
              {isGit(source) ? <GitBranch size={15} /> : <FolderOpen size={15} />}
            </span>
            <input
              id="repo-source"
              ref={inputRef}
              className="input mono py-2.5"
              style={{ paddingLeft: 36 }}
              placeholder="https://github.com/org/repo   or   D:\path\to\project"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <button className="btn btn-primary shrink-0 px-4" disabled={submitting || !source.trim()}>
            {submitting ? <Spinner className="h-3.5 w-3.5 border-t-[#08111f]" /> : <Plus size={16} />} Analyze
          </button>
        </div>
        {submitError && <div className="mt-3"><ErrorBox>{submitError}</ErrorBox></div>}
        {notice && <div className="mt-3 text-xs text-accent">{notice}</div>}
      </form>

      {error && <ErrorBox>Could not reach the API: {error}</ErrorBox>}
      {loading && !repos && <div className="flex items-center gap-2 text-muted"><Spinner /> Loading repositories…</div>}
      {repos && repos.length === 0 && <Welcome onStart={() => inputRef.current?.focus()} />}

      {repos && repos.length > 0 && (
        <section>
          <div className="flex items-center gap-3 mb-3">
            <h2 className="text-sm font-medium text-muted">
              Your repositories <span className="text-faint">· {repos.length}</span>
            </h2>
            {repos.length > 3 && (
              <div className="relative ml-auto w-44 sm:w-64">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <input className="input py-1.5" style={{ paddingLeft: 32 }} placeholder="Filter by name, language…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            )}
          </div>
          {shown.length === 0 ? (
            <p className="text-sm text-faint py-6 text-center">No repository matches “{q}”.</p>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2">
              {shown.map((r) => <RepoCard key={r.id} repo={r} onChange={refresh} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function RepoCard({ repo: r, onChange }: { repo: Repo; onChange: () => void }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const s = r.summary;
  const ready = r.status === "ready";
  const langs = (r.stack?.languages ?? []).filter((l) => l.share > 0).slice(0, 5);
  const frameworks = (r.stack?.frameworks ?? []).slice(0, 3);
  const when = parseUtc(s?.last_activity_at ?? r.updated_at);
  const base = `/repos/${r.id}`;

  const reanalyze = async () => {
    setMenu(false);
    await api.repos.reingest(r.id).catch(() => undefined);
    onChange();
  };
  const remove = async () => {
    setMenu(false);
    if (!confirm(`Remove "${r.name}" with its graph, findings, chats and docs? This cannot be undone.`)) return;
    await api.repos.remove(r.id);
    onChange();
  };

  return (
    <li className="card group relative flex flex-col min-w-0 hover:border-line-strong transition-colors">
      <Link href={base} className="p-4 pb-3 flex-1 block rounded-t-lg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 h-8 w-8 shrink-0 rounded-md bg-elev2 border border-line flex items-center justify-center text-muted">
            {isGit(r.source) ? <GitBranch size={15} /> : <FolderOpen size={15} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 pr-8">
              <span className="font-semibold truncate group-hover:text-accent transition-colors">{r.name}</span>
              {!ready && <StatusPill status={r.status} />}
            </div>
            <div className="text-xs text-faint mono truncate" title={r.source}>{shortSource(r.source)}</div>
          </div>
          {ready && s?.health_grade && s.last_analysis_at && (
            <span
              className="shrink-0 h-9 w-9 rounded-md border flex flex-col items-center justify-center leading-none mr-7"
              style={{ borderColor: GRADE_COLOR[s.health_grade] ?? "var(--border-strong)", color: GRADE_COLOR[s.health_grade] ?? "var(--fg-muted)" }}
              title={`Health ${s.health_score ?? "–"} / 100 (Audit tab)`}
            >
              <span className="text-sm font-bold">{s.health_grade}</span>
              <span className="text-[9px] opacity-80">{Math.round(s.health_score ?? 0)}</span>
            </span>
          )}
        </div>

        {busy(r) && (
          <div className="mt-3">
            <div className="h-1 rounded-full bg-elev2 overflow-hidden"><div className="h-full w-full rounded-full bg-accent/60 pulse" /></div>
            <div className="text-xs text-muted mt-1.5">{r.status === "pending" ? "Queued…" : "Reading files and building the code graph…"}</div>
          </div>
        )}
        {r.status === "failed" && <div className="mt-3 text-xs text-danger line-clamp-2" title={r.error}>{r.error || "Analysis failed"}</div>}

        {ready && (
          <>
            {langs.length > 0 && (
              <div className="mt-3">
                <div className="flex h-1.5 rounded-full overflow-hidden bg-elev2">
                  {langs.map((l) => <span key={l.name} style={{ width: `${l.share * 100}%`, background: langColor(l.name) }} title={`${l.name} ${Math.round(l.share * 100)}%`} />)}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px] text-muted">
                  {langs.slice(0, 3).map((l) => (
                    <span key={l.name} className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ background: langColor(l.name) }} />
                      {l.name} <span className="text-faint">{Math.round(l.share * 100)}%</span>
                    </span>
                  ))}
                  {frameworks.map((f) => <span key={f} className="text-faint">· {f}</span>)}
                </div>
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1"><FileCode2 size={12} className="text-faint" />{(r.stats.files ?? 0).toLocaleString()} files</span>
              {typeof r.stats.lines === "number" && <span>{r.stats.lines.toLocaleString()} lines</span>}
              <span className="flex items-center gap-1"><Network size={12} className="text-faint" />{(r.stats.nodes ?? 0).toLocaleString()} symbols</span>
              <Findings summary={s} />
            </div>
          </>
        )}
      </Link>

      <div className="flex flex-wrap items-center gap-0.5 border-t border-line px-2 py-1.5 text-xs">
        {ready ? (
          <>
            <Quick href={base} icon={LayoutDashboard} label="Overview" />
            <Quick href={`${base}/map`} icon={MapIcon} label="Map" />
            <Quick href={`${base}/chat`} icon={MessageSquare} label="Chat" badge={s?.conversations || undefined} />
            <Quick href={`${base}/audit`} icon={ShieldCheck} label="Audit" />
            <Quick href={`${base}/tools`} icon={Wrench} label="Tools" />
          </>
        ) : (
          <span className="px-2 text-faint">{r.status === "failed" ? "Fix the source, then re-analyze" : "Shortcuts appear when the analysis is done"}</span>
        )}
        <span className="ml-auto text-faint pr-1 whitespace-nowrap" title={when?.toLocaleString()}>{timeAgo(when)}</span>
      </div>

      {/* actions */}
      <div ref={menuRef} className="absolute top-3 right-3">
        <button
          className="btn btn-ghost p-1 opacity-60 group-hover:opacity-100 focus:opacity-100"
          aria-label="Repository actions"
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
        >
          <Ellipsis size={16} />
        </button>
        {menu && (
          <div className="absolute right-0 mt-1 z-20 w-44 card shadow-xl py-1 text-sm">
            <button className="w-full text-left px-3 py-1.5 hover:bg-elev2 flex items-center gap-2 disabled:opacity-50" onClick={reanalyze} disabled={busy(r)}>
              <RefreshCw size={14} /> Re-analyze
            </button>
            <button className="w-full text-left px-3 py-1.5 hover:bg-elev2 flex items-center gap-2 text-danger" onClick={remove}>
              <Trash2 size={14} /> Remove…
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function Findings({ summary: s }: { summary?: Repo["summary"] }) {
  if (!s || (!s.last_analysis_at && !s.open_findings)) return <span className="text-faint">not audited yet</span>;
  if (!s.open_findings) return <span className="text-ok">no open findings</span>;
  const order: Severity[] = ["critical", "high", "medium", "low"];
  return (
    <span className="flex items-center gap-1.5" title={order.map((k) => `${k}: ${s.open_by_severity[k] ?? 0}`).join("\n")}>
      <span className="flex gap-0.5">
        {order.filter((k) => s.open_by_severity[k]).map((k) => <span key={k} className="h-2 w-2 rounded-full" style={{ background: SEVERITY_COLOR[k] }} />)}
      </span>
      {s.open_findings} open findings
    </span>
  );
}

function Quick({ href, icon: Icon, label, badge }: { href: string; icon: typeof MapIcon; label: string; badge?: number }) {
  return (
    <Link href={href} className={clsx("flex items-center gap-1.5 rounded px-2 py-1 text-muted hover:bg-elev2 hover:text-fg transition-colors")}>
      <Icon size={13} /> {label}
      {badge ? <span className="text-faint">{badge}</span> : null}
    </Link>
  );
}

/** First visit: what ARCHON does, in three steps. */
function Welcome({ onStart }: { onStart: () => void }) {
  const steps = [
    { icon: Plus, title: "Add a repository", text: "Paste a GitHub URL or a local folder. ARCHON reads every file and builds a graph of folders, files, functions, calls and imports." },
    { icon: MapIcon, title: "Explore it", text: "Zoom through the Code Map, ask Chat how something works, and read the reconstructed architecture." },
    { icon: ShieldCheck, title: "Improve it", text: "Run the Audit for security, performance and debt findings; use the Tools to debug, plan features and check change impact." },
  ];
  return (
    <div className="card p-6">
      <div className="text-lg font-semibold">Start with a repository</div>
      <p className="text-muted text-sm mt-1">Nothing analyzed yet. Here is what happens once you add one:</p>
      <ol className="grid gap-4 sm:grid-cols-3 mt-5">
        {steps.map((st, i) => (
          <li key={st.title} className="rounded-lg border border-line bg-elev2/50 p-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="h-6 w-6 rounded-full bg-accent-soft text-accent flex items-center justify-center text-xs">{i + 1}</span>
              {st.title}
            </div>
            <p className="text-xs text-muted mt-2 leading-relaxed">{st.text}</p>
          </li>
        ))}
      </ol>
      <button className="btn btn-primary mt-5" onClick={onStart}><Plus size={15} /> Add your first repository</button>
    </div>
  );
}
