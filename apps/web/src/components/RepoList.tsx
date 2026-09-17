"use client";

import Link from "next/link";
import { useState } from "react";
import { FolderGit2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api, type Repo } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { Empty, ErrorBox, Spinner, StatusPill } from "@/components/ui";

const active = (repos: unknown) => Array.isArray(repos) && repos.some((r: Repo) => r.status === "pending" || r.status === "ingesting");

export function RepoList() {
  const { data: repos, error, loading, refresh } = useApi("repos", () => api.repos.list(), {
    pollMs: 1500,
    pollWhile: active,
  });
  const [source, setSource] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.repos.create(source.trim());
      setSource("");
      refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async (r: Repo) => {
    if (!confirm(`Remove "${r.name}" and its graph?`)) return;
    await api.repos.remove(r.id);
    refresh();
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="card p-4 flex flex-col gap-3">
        <label className="text-sm font-medium">Add repository</label>
        <div className="flex gap-2">
          <input
            className="input mono"
            placeholder="https://github.com/org/repo.git   or   D:\path\to\local\project"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={submitting}
          />
          <button className="btn btn-primary shrink-0" disabled={submitting || !source.trim()}>
            {submitting ? <Spinner /> : <Plus size={16} />} Analyze
          </button>
        </div>
        <p className="text-xs text-faint">
          Git URLs are shallow-cloned into the workspace. Local paths are analyzed in place and never modified.
        </p>
        {submitError && <ErrorBox>{submitError}</ErrorBox>}
      </form>

      {error && <ErrorBox>Could not reach the API: {error}</ErrorBox>}
      {loading && !repos && (
        <div className="flex items-center gap-2 text-muted"><Spinner /> Loading…</div>
      )}
      {repos && repos.length === 0 && <Empty>No repositories yet. Add one above to get started.</Empty>}

      <ul className="grid gap-3">
        {repos?.map((r) => (
          <li key={r.id} className="card p-4 flex items-center gap-4">
            <FolderGit2 className="text-muted shrink-0" size={20} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3">
                <Link href={`/repos/${r.id}`} className="font-medium hover:text-accent truncate">
                  {r.name}
                </Link>
                <StatusPill status={r.status} />
                {r.stack?.primary_language && <span className="chip">{r.stack.primary_language}</span>}
                {r.stack?.frameworks?.slice(0, 3).map((f) => (
                  <span key={f} className="chip">{f}</span>
                ))}
              </div>
              <div className="text-xs text-faint mono truncate mt-1">{r.source}</div>
              {r.status === "failed" && <div className="text-xs text-danger mt-1">{r.error}</div>}
              {r.status === "ready" && (
                <div className="text-xs text-muted mt-1">
                  {r.stats.files ?? 0} files · {r.stats.nodes ?? 0} nodes · {r.stats.edges ?? 0} edges
                  {typeof r.stats.analysis_seconds === "number" && ` · analyzed in ${r.stats.analysis_seconds}s`}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button className="btn btn-ghost" title="Re-analyze" onClick={() => api.repos.reingest(r.id).then(refresh)} disabled={r.status === "ingesting"}>
                <RefreshCw size={16} />
              </button>
              <button className="btn btn-ghost hover:text-danger" title="Remove" onClick={() => remove(r)}>
                <Trash2 size={16} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
