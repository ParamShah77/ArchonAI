"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { api, type Repo } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { ErrorBox, Spinner, StatusPill } from "@/components/ui";
import { CommandPalette, PaletteButton } from "@/components/CommandPalette";

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
      <CommandPalette />
      <div className="border-b border-line bg-elev/60 px-6">
        <div className="flex items-center gap-3 pt-4">
          <Link href="/" className="text-faint hover:text-fg text-sm">Repositories</Link>
          <span className="text-faint">/</span>
          <RepoSwitcher repo={repo} section={pathname.slice(base.length)} />
          <StatusPill status={repo.status} />
          {repo.default_branch && (
            <span className="chip mono" title={repo.commit_sha}>
              {repo.default_branch}@{repo.commit_sha.slice(0, 7)}
            </span>
          )}
          <span className="text-xs text-faint mono truncate ml-2 min-w-0">{repo.source}</span>
          <PaletteButton className="ml-auto shrink-0 hidden md:inline-flex" />
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

/** The repository name doubles as a switcher: pick another repository and stay on the same tab. */
function RepoSwitcher({ repo, section }: { repo: Repo; section: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: repos } = useApi(open ? "switcher:repos" : null, () => api.repos.list());
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  // query strings (a selected node, a tool) belong to the old repository; keep only the tab
  const tab = section.split("?")[0];
  return (
    <div ref={ref} className="relative">
      <button
        className="flex items-center gap-1.5 rounded-md px-1.5 -mx-1.5 py-0.5 hover:bg-elev2"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch repository"
      >
        <h1 className="text-lg font-semibold">{repo.name}</h1>
        <ChevronDown size={15} className="text-faint" />
      </button>
      {open && (
        <div className="absolute left-0 mt-1 z-30 w-72 card shadow-xl py-1" role="listbox">
          {!repos && <div className="px-3 py-2 text-xs text-faint flex items-center gap-2"><Spinner className="h-3 w-3" /> Loading…</div>}
          {repos?.map((r) => (
            <Link
              key={r.id}
              href={`/repos/${r.id}${r.status === "ready" ? tab : ""}`}
              onClick={() => setOpen(false)}
              className={clsx("flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-elev2", r.id === repo.id ? "text-fg" : "text-muted")}
              role="option"
              aria-selected={r.id === repo.id}
            >
              <span className="w-4 shrink-0">{r.id === repo.id && <Check size={14} className="text-accent" />}</span>
              <span className="truncate">{r.name}</span>
              <span className="ml-auto text-xs text-faint">{r.status === "ready" ? r.stack?.primary_language : r.status}</span>
            </Link>
          ))}
          <div className="border-t border-line mt-1 pt-1">
            <Link href="/" onClick={() => setOpen(false)} className="block px-3 py-1.5 text-sm text-muted hover:bg-elev2 hover:text-fg">
              All repositories…
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
