"use client";

/**
 * Quick jump (Ctrl/⌘ + K): repositories, the sections and tools of the repository you are in, any file,
 * function or endpoint in it, and "add a repository". Typing filters; ↑ ↓ choose; Enter goes.
 * Open it from anywhere with the shortcut, or with `openPalette()` (decisions.md D-034).
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { CornerDownLeft, FolderOpen, GitBranch, Plus, Search } from "lucide-react";
import { api, KIND_STYLE, type GraphNode } from "@/lib/api";
import { useApi, useDebounced } from "@/lib/hooks";
import { TOOLS } from "@/components/tools/toolList";

const EVENT = "archon:palette";
export const openPalette = () => window.dispatchEvent(new Event(EVENT));
const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

const SECTIONS = [
  { path: "", label: "Overview" },
  { path: "/map", label: "Code Map" },
  { path: "/chat", label: "Chat" },
  { path: "/audit", label: "Audit" },
  { path: "/intel", label: "Intel" },
  { path: "/docs", label: "Docs" },
];

interface Item {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  href: string;
}

/** Subsequence match with a bonus for word starts; 0 = no match. */
function score(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const i0 = t.indexOf(q);
  if (i0 >= 0) return 100 - i0;
  let s = 0, j = 0;
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] === q[j]) {
      s += i === 0 || /[\s/_.-]/.test(t[i - 1]) ? 3 : 1;
      j++;
    }
  }
  return j === q.length ? s : 0;
}

export function CommandPalette() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q.trim(), 180);
  const repoId = pathname.match(/^\/repos\/([^/]+)/)?.[1] ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(EVENT, onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const repos = useApi(open ? "palette:repos" : null, () => api.repos.list());
  const symbols = useApi(open && repoId && dq.length >= 2 ? `palette:search:${repoId}:${dq}` : null, () => api.graph.search(repoId!, dq));
  const current = repos.data?.find((r) => r.id === repoId);

  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    const all: Item[] = [];
    if (current) {
      const base = `/repos/${current.id}`;
      for (const s of SECTIONS) all.push({ key: `s${s.path}`, group: current.name, label: s.label, href: base + s.path });
      for (const tool of TOOLS) {
        const Icon = tool.icon;
        all.push({ key: `t${tool.id}`, group: "Tools", label: tool.label, hint: "tool", icon: <Icon size={14} />, href: `${base}/tools?tool=${tool.id}` });
      }
    }
    for (const r of repos.data ?? []) {
      if (r.id === repoId) continue;
      const git = /^(https?:|git@|ssh:)/.test(r.source);
      all.push({
        key: `r${r.id}`,
        group: "Repositories",
        label: r.name,
        hint: r.stack?.primary_language,
        icon: git ? <GitBranch size={14} /> : <FolderOpen size={14} />,
        href: `/repos/${r.id}`,
      });
    }
    all.push({ key: "add", group: "Actions", label: "Add a repository", icon: <Plus size={14} />, href: "/?add=1" });
    const ranked = all
      .map((it) => ({ it, s: Math.max(score(it.label, t), score(`${it.group} ${it.label}`, t) * 0.5) }))
      .filter((x) => x.s > 0);
    if (t) ranked.sort((a, b) => b.s - a.s);
    const out = ranked.map((x) => x.it).slice(0, t ? 12 : 40);
    // code results from the repository you are in
    const code: Item[] = (symbols.data?.results ?? []).slice(0, 8).map((n: GraphNode) => ({
      key: `n${n.id}`,
      group: "Code",
      label: n.kind === "method" && n.meta.class ? `${n.meta.class}.${n.name}` : n.name,
      hint: `${KIND_STYLE[n.kind]?.label ?? n.kind} · ${n.path}`,
      icon: <span className="h-2.5 w-2.5 rounded-full" style={{ background: KIND_STYLE[n.kind]?.color ?? "#8b93a7" }} />,
      href: `/repos/${repoId}/map?node=${n.id}&focus=${n.id}`,
    }));
    return t ? [...out.slice(0, 6), ...code, ...out.slice(6)] : out;
  }, [q, current, repos.data, repoId, symbols.data]);

  // keep the highlighted row valid and visible
  const sel = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  const close = () => {
    setOpen(false);
    setQ("");
    setActive(0);
  };
  const go = (it: Item | undefined) => {
    if (!it) return;
    close();
    // "add a repository" on the home page just focuses the add box
    if (it.key === "add" && pathname === "/") window.dispatchEvent(new Event("archon:add"));
    else router.push(it.href);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(Math.min(items.length - 1, sel + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, sel - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh]" onMouseDown={close}>
      <div
        role="dialog"
        aria-label="Quick jump"
        className="card w-full max-w-xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={15} className="text-faint shrink-0" />
          <input
            ref={inputRef}
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-faint"
            placeholder={repoId ? "Jump to a section, tool, repository, or any file / function…" : "Jump to a repository or action…"}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            aria-activedescendant={items[sel] ? `pal-${items[sel].key}` : undefined}
          />
          <span className="kbd shrink-0">Esc</span>
        </div>
        <div ref={listRef} className="max-h-[56vh] overflow-y-auto py-1" role="listbox">
          {items.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">{repos.loading || symbols.loading || q.trim() !== dq ? "Searching…" : "Nothing matches."}</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.key}>
                {head && <div className="px-3 pt-2 pb-1 stat-label">{head}</div>}
                <button
                  id={`pal-${it.key}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === sel}
                  className={clsx("w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-sm", i === sel ? "bg-accent-soft text-fg" : "text-muted")}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(it)}
                >
                  <span className="w-5 flex justify-center text-faint shrink-0">{it.icon}</span>
                  <span className={clsx("truncate", it.group === "Code" && "mono")}>{it.label}</span>
                  {it.hint && <span className="ml-auto pl-3 text-xs text-faint truncate max-w-[45%]">{it.hint}</span>}
                  {i === sel && <CornerDownLeft size={13} className={clsx("text-faint shrink-0", !it.hint && "ml-auto")} />}
                </button>
              </div>
            );
          })}
          {repoId && dq.length >= 2 && symbols.loading && <div className="px-3 py-1.5 text-xs text-faint">Searching the code…</div>}
        </div>
      </div>
    </div>
  );
}

/** The header button that opens the palette, showing the shortcut. */
export function PaletteButton({ className }: { className?: string }) {
  return (
    <button className={clsx("btn btn-ghost text-xs gap-2 border border-line", className)} onClick={openPalette} title="Quick jump">
      <Search size={13} /> Jump to…
      <span className="kbd" suppressHydrationWarning>{isMac() ? "⌘K" : "Ctrl K"}</span>
    </button>
  );
}
