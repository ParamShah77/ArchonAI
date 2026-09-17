"use client";

import Link from "next/link";
import { useState } from "react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useApi } from "@/lib/hooks";
import { useRepo } from "@/components/RepoShell";
import { Empty, ErrorBox, Section, Spinner, Stat } from "@/components/ui";

const TABS = ["API", "Database", "Dependencies", "Tests"] as const;
type Tab = (typeof TABS)[number];

export function IntelPanel() {
  const [tab, setTab] = useState<Tab>("API");
  return (
    <div className="p-6 space-y-6 max-w-7xl w-full mx-auto">
      <div className="flex rounded-md border border-line-strong overflow-hidden w-fit">
        {TABS.map((t) => (
          <button key={t} className={clsx("px-4 py-1.5 text-sm", tab === t ? "bg-accent-soft text-accent" : "text-muted hover:text-fg")} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === "API" && <ApiIntel />}
      {tab === "Database" && <DbIntel />}
      {tab === "Dependencies" && <DepsIntel />}
      {tab === "Tests" && <TestsIntel />}
    </div>
  );
}

function Loading({ error }: { error: string | null }) {
  if (error) return <ErrorBox>{error}</ErrorBox>;
  return <div className="flex items-center gap-2 text-muted text-sm"><Spinner /> Loading…</div>;
}

const METHOD_COLOR: Record<string, string> = { GET: "#7ee0a0", POST: "#5aa9ff", PUT: "#ffb86c", PATCH: "#ffb86c", DELETE: "#ff7b9c", ANY: "#8b93a7", USE: "#8b93a7", WS: "#c792ea" };

function ApiIntel() {
  const { repo } = useRepo();
  const { data, error } = useApi(`api:${repo.id}`, () => api.analysis.apiIntel(repo.id));
  const [q, setQ] = useState("");
  if (!data) return <Loading error={error} />;
  const eps = data.endpoints.filter((e) => !q || `${e.method} ${e.route} ${e.handler}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <Stat label="Endpoints" value={data.count} />
        <Stat label="Resources" value={Object.keys(data.resources).length} />
        <Stat label="Auth coverage" value={data.auth_coverage === null ? "—" : `${Math.round(data.auth_coverage * 100)}%`} hint="heuristic: auth decorator/dependency/guard detected" />
        <Stat label="Versioned" value={data.versioned ? "yes" : "no"} />
        {Object.entries(data.by_method).map(([m, c]) => <Stat key={m} label={m} value={c} />)}
      </div>
      <Section title="Endpoints" action={<input className="input py-1 w-64" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />}>
        {eps.length === 0 && <Empty>No endpoints detected.</Empty>}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-faint text-[11px] uppercase tracking-wider"><tr><th className="pb-2">Method</th><th className="pb-2">Route</th><th className="pb-2">Handler</th><th className="pb-2">Auth</th><th className="pb-2">Tables</th><th className="pb-2">Calls</th></tr></thead>
            <tbody>
              {eps.map((e) => (
                <tr key={e.id} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3"><span className="chip mono" style={{ color: METHOD_COLOR[e.method] ?? "#8b93a7" }}>{e.method}</span></td>
                  <td className="py-1.5 pr-3 mono"><Link href={`/repos/${repo.id}/map?focus=${e.id}&node=${e.id}&depth=2`} className="hover:text-accent">{e.route}</Link></td>
                  <td className="py-1.5 pr-3 mono text-xs text-muted"><div>{e.handler}</div><div className="text-faint">{e.path}:{e.line}</div></td>
                  <td className="py-1.5 pr-3">{e.auth ? <span className="text-ok text-xs">yes</span> : <span className="text-warn text-xs">not detected</span>}</td>
                  <td className="py-1.5 pr-3 text-xs mono">{e.reaches_tables.join(", ") || <span className="text-faint">—</span>}</td>
                  <td className="py-1.5 text-xs text-muted">{e.calls.slice(0, 5).join(", ")}{e.calls.length > 5 ? ` +${e.calls.length - 5}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function DbIntel() {
  const { repo } = useRepo();
  const { data, error } = useApi(`db:${repo.id}`, () => api.analysis.dbIntel(repo.id));
  if (!data) return <Loading error={error} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <Stat label="Tables" value={data.table_count} />
        <Stat label="ORM models" value={data.orm_tables} />
        <Stat label="Relationships" value={data.relationships.length} />
        <Stat label="Migrations" value={data.migrations.length} />
        <Stat label="Raw SQL sites" value={data.raw_sql_count} />
        <Stat label="Engines" value={data.engines.join(", ") || "—"} />
      </div>
      {data.tables.length === 0 && <Empty>No tables detected (SQL DDL, ORM models with __tablename__, JPA @Entity, TypeORM @Entity, Prisma models).</Empty>}
      <div className="grid lg:grid-cols-2 gap-4">
        {data.tables.map((t) => (
          <Section key={t.id} title={t.name} action={<Link href={`/repos/${repo.id}/map?focus=${t.id}&node=${t.id}&depth=1`} className="btn btn-ghost text-xs">map →</Link>}>
            <div className="space-y-2 text-sm">
              <div className="text-xs text-faint mono">{t.declared_in.join(", ")}{t.models.length > 0 && ` · models: ${t.models.join(", ")}`}</div>
              {t.columns.length > 0 && <div className="flex flex-wrap gap-1">{t.columns.map((c) => <span key={c} className="chip mono">{c}</span>)}</div>}
              {t.references.length > 0 && <div className="text-xs">references: <span className="mono text-accent">{t.references.join(", ")}</span></div>}
              <div className="text-xs text-muted">Accessed by {t.access_count} function{t.access_count === 1 ? "" : "s"}{t.accessed_by.length > 0 && ": "}
                {t.accessed_by.slice(0, 8).map((a) => <Link key={a.id} href={`/repos/${repo.id}/map?focus=${a.id}&node=${a.id}`} className="mono hover:text-accent mr-2">{a.name}</Link>)}
              </div>
              {t.has_pk === false && <div className="text-warn text-xs">No obvious primary key column.</div>}
            </div>
          </Section>
        ))}
      </div>
      {data.migrations.length > 0 && <Section title="Migrations"><ul className="mono text-xs space-y-1 text-muted">{data.migrations.map((m) => <li key={m}>{m}</li>)}</ul></Section>}
      {data.raw_sql_sites.length > 0 && (
        <Section title={`Raw SQL sites (${data.raw_sql_count})`}>
          <ul className="mono text-xs space-y-1">{data.raw_sql_sites.slice(0, 60).map((s, i) => <li key={i}><span className="text-faint">{s.path}:{s.line}</span> <span className="text-muted">{s.text}</span></li>)}</ul>
        </Section>
      )}
    </div>
  );
}

function DepsIntel() {
  const { repo } = useRepo();
  const { data, error } = useApi(`deps:${repo.id}`, () => api.analysis.deps(repo.id));
  const [q, setQ] = useState("");
  if (!data) return <Loading error={error} />;
  const rows = data.inventory.filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <Stat label="Declared" value={data.total} />
        <Stat label="Dev only" value={data.dev_count} />
        <Stat label="Unused" value={data.unused.length} />
        <Stat label="Undeclared" value={data.undeclared.length} />
        <Stat label="Risky" value={data.risky.length} />
        <Stat label="Unpinned" value={data.unpinned.length} />
      </div>
      {(data.risky.length > 0 || data.undeclared.length > 0) && (
        <div className="grid lg:grid-cols-2 gap-4">
          {data.risky.length > 0 && <Section title="Risky"><ul className="text-sm space-y-1">{data.risky.map((r) => <li key={r.name}><span className="mono text-danger">{r.name}</span> <span className="text-muted">— {r.reason}</span></li>)}</ul></Section>}
          {data.undeclared.length > 0 && <Section title="Imported but not declared"><ul className="text-sm space-y-1">{data.undeclared.map((u) => <li key={u.module}><span className="mono text-warn">{u.module}</span> <span className="text-faint text-xs">← {u.files.slice(0, 3).join(", ")}</span></li>)}</ul></Section>}
        </div>
      )}
      <Section title="Inventory" action={<input className="input py-1 w-56" placeholder="filter…" value={q} onChange={(e) => setQ(e.target.value)} />}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-faint text-[11px] uppercase tracking-wider"><tr><th className="pb-2">Package</th><th className="pb-2">Ecosystem</th><th className="pb-2">Version</th><th className="pb-2 text-right">Importers</th><th className="pb-2">Manifest</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={`${d.ecosystem}:${d.name}`} className={clsx("border-t border-line", d.importers === 0 && !d.dev && "text-muted")}>
                  <td className="py-1 pr-3 mono"><Link href={`/repos/${repo.id}/map?focus=${d.node_id}&node=${d.node_id}`} className="hover:text-accent">{d.name}</Link>{d.dev && <span className="chip ml-2">dev</span>}</td>
                  <td className="py-1 pr-3 text-xs">{d.ecosystem}</td>
                  <td className="py-1 pr-3 mono text-xs">{d.version || <span className="text-warn">unpinned</span>}</td>
                  <td className="py-1 pr-3 mono text-right">{d.importers}</td>
                  <td className="py-1 text-xs text-faint mono">{d.manifest}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function TestsIntel() {
  const { repo } = useRepo();
  const { data, error } = useApi(`tests:${repo.id}`, () => api.analysis.tests(repo.id));
  if (!data) return <Loading error={error} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-3">
        <Stat label="Test files" value={data.test_files} />
        <Stat label="Test cases" value={data.test_cases} />
        <Stat label="Source files" value={data.source_files} />
        <Stat label="Files with tests" value={data.coverage_ratio === null ? "—" : `${Math.round(data.coverage_ratio * 100)}%`} hint="files imported by (or name-matched to) a test file" />
        <Stat label="Frameworks" value={data.frameworks.join(", ") || "—"} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Riskiest untested code">
          {data.risky_untested.length === 0 && <Empty>Nothing risky without tests.</Empty>}
          <ul className="text-sm space-y-1.5">
            {data.risky_untested.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="chip mono w-9 justify-center">{r.score}</span>
                <Link href={`/repos/${repo.id}/tools?tool=tests&node=${r.id}`} className="mono hover:text-accent">{r.name}</Link>
                <span className="text-faint text-xs truncate">{r.path}:{r.line}</span>
                {r.endpoint && <span className="chip text-warn">endpoint</span>}
                {r.queries_db && <span className="chip text-danger">db</span>}
                {r.callers > 0 && <span className="chip">{r.callers} callers</span>}
              </li>
            ))}
          </ul>
        </Section>
        <Section title={`Untested files (${data.untested_files.length})`}>
          <ul className="mono text-xs space-y-1 text-muted max-h-96 overflow-y-auto">{data.untested_files.map((f) => <li key={f}>{f}</li>)}</ul>
        </Section>
      </div>
    </div>
  );
}
