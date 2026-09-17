import clsx from "clsx";
import type { ReactNode } from "react";
import { KIND_STYLE, type NodeKind, type RepoStatus } from "@/lib/api";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={clsx("inline-block h-4 w-4 rounded-full border-2 border-line-strong border-t-accent animate-spin", className)}
      aria-label="loading"
    />
  );
}

export function StatusPill({ status }: { status: RepoStatus }) {
  const map: Record<RepoStatus, string> = {
    pending: "text-muted border-line-strong",
    ingesting: "text-accent border-accent/40",
    ready: "text-ok border-ok/40",
    failed: "text-danger border-danger/40",
  };
  return (
    <span className={clsx("chip", map[status])}>
      <span className={clsx("h-1.5 w-1.5 rounded-full bg-current", status === "ingesting" && "pulse")} />
      {status}
    </span>
  );
}

export function KindBadge({ kind, className }: { kind: NodeKind; className?: string }) {
  const s = KIND_STYLE[kind];
  return (
    <span className={clsx("chip", className)} style={{ color: s.color, borderColor: `${s.color}55` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="card px-4 py-3 min-w-[120px]">
      <div className="stat-label">{label}</div>
      <div className="text-xl font-semibold mt-1 mono" title={hint}>
        {value}
      </div>
    </div>
  );
}

export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx("card", className)}>
      <header className="flex items-center justify-between px-4 py-2.5 border-b border-line">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-sm text-faint py-6 text-center">{children}</div>;
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{children}</div>;
}
