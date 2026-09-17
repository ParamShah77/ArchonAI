"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { createContext, useContext, type ReactNode } from "react";
import { api, type Repo } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ErrorBox, Spinner, StatusPill } from "@/components/ui";

const RepoContext = createContext<{ repo: Repo; refresh: () => void } | null>(null);

export function useRepo() {
  const ctx = useContext(RepoContext);
  if (!ctx) throw new Error("useRepo must be used inside RepoShell");
  return ctx;
}

const TABS = [
  { href: "", label: "Overview" },
  { href: "/map", label: "Code Map" },
  { href: "/chat", label: "Chat" },
  { href: "/audit", label: "Audit" },
  { href: "/intel", label: "Intel" },
  { href: "/docs", label: "Docs" },
  { href: "/tools", label: "Tools" },
];

export function RepoShell({ id, children }: { id: string; children: ReactNode }) {
  const pathname = usePathname();
  const { data: repo, error, refresh } = useApi(`repo:${id}`, () => api.repos.get(id), {
    pollMs: 1500,
    pollWhile: (r) => (r as Repo).status === "pending" || (r as Repo).status === "ingesting",
  });

  if (error) return <div className="p-6"><ErrorBox>{error}</ErrorBox></div>;
  if (!repo) return <div className="p-6 flex items-center gap-2 text-muted"><Spinner /> Loading repository…</div>;

  const base = `/repos/${id}`;
  return (
    <RepoContext.Provider value={{ repo, refresh }}>
      <div className="border-b border-line bg-elev/60 px-6">
        <div className="flex items-center gap-3 pt-4">
          <Link href="/" className="text-faint hover:text-fg text-sm">Repositories</Link>
          <span className="text-faint">/</span>
          <h1 className="text-lg font-semibold">{repo.name}</h1>
          <StatusPill status={repo.status} />
          {repo.default_branch && (
            <span className="chip mono" title={repo.commit_sha}>
              {repo.default_branch}@{repo.commit_sha.slice(0, 7)}
            </span>
          )}
          <span className="text-xs text-faint mono truncate ml-2">{repo.source}</span>
        </div>
        <nav className="flex gap-1 mt-3 -mb-px">
          {TABS.map((t) => {
            const href = base + t.href;
            const isActive = t.href === "" ? pathname === base : pathname.startsWith(href);
            return (
              <Link
                key={t.href}
                href={href}
                className={clsx(
                  "px-3 py-2 text-sm border-b-2 transition-colors",
                  isActive ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>
      {repo.status !== "ready" ? (
        <div className="p-6">
          {repo.status === "failed" ? (
            <ErrorBox>Ingestion failed: {repo.error}</ErrorBox>
          ) : (
            <div className="flex items-center gap-2 text-muted">
              <Spinner /> {repo.status === "pending" ? "Queued for analysis…" : "Cloning and analyzing the repository…"}
            </div>
          )}
        </div>
      ) : (
        children
      )}
    </RepoContext.Provider>
  );
}
