"""Capability 13 — database intelligence: schema, relationships, access paths, risky data operations."""

from __future__ import annotations

import re
from typing import Any

from archon.analysis.base import AnalysisContext, Analyzer
from archon.analysis.findings import Finding, Severity
from archon.graph.model import EdgeKind, NodeKind

_MIGRATION_PATH = re.compile(
    r"(^|/)(migrations?|alembic|db/migrate|prisma/migrations|flyway|liquibase)(/|$)", re.IGNORECASE
)
_RAW_SQL = re.compile(r"(?i)[\"'`]\s*(SELECT|INSERT|UPDATE|DELETE)\b")
_DELETE_NO_WHERE = re.compile(r"(?i)[\"'`]\s*DELETE\s+FROM\s+\w+\s*[\"'`;]")
_UPDATE_NO_WHERE = re.compile(r"(?i)[\"'`]\s*UPDATE\s+\w+\s+SET\s+[^\"'`]*[\"'`]\s*[,)]?\s*$")


def build_report(ctx: AnalysisContext) -> dict[str, Any]:
    rg = ctx.rg
    tables = []
    rel_edges = []
    for t in sorted(rg.by_kind(NodeKind.TABLE), key=lambda n: n.name):
        declared_in = [rg.nodes[s] for s, d in rg.in_edges(t.id, EdgeKind.CONTAINS) if s in rg.nodes]
        accessed_by = [
            rg.nodes[s]
            for s, d in rg.in_edges(t.id, EdgeKind.QUERIES)
            if s in rg.nodes and rg.nodes[s].kind != NodeKind.TABLE
        ]
        refs = [
            rg.nodes[x].name
            for x, d in rg.out_edges(t.id, EdgeKind.QUERIES)
            if x in rg.nodes and rg.nodes[x].kind == NodeKind.TABLE
        ]
        for r in refs:
            rel_edges.append({"from": t.name, "to": r})
        cols = t.meta.get("columns") or []
        tables.append(
            {
                "id": t.id,
                "name": t.name,
                "path": t.path,
                "line": t.start_line,
                "columns": cols,
                "references": refs,
                "models": [d.name for d in declared_in if d.kind == NodeKind.CLASS],
                "declared_in": sorted({d.path for d in declared_in}),
                "accessed_by": [
                    {"name": a.qualified_name.split("::")[-1], "path": a.path, "id": a.id} for a in accessed_by
                ][:50],
                "access_count": len(accessed_by),
                "orm": bool(t.meta.get("orm")),
                "has_pk": any(re.search(r"(?i)\bid\b|_id$|^pk", c) for c in cols) if cols else None,
            }
        )
    migrations = sorted(f.path for f in rg.by_kind(NodeKind.FILE) if _MIGRATION_PATH.search(f.path))
    raw_sql_sites: list[dict[str, Any]] = []
    for f in ctx.files({"python", "javascript", "typescript", "tsx", "go", "java"}):
        if ctx.is_test_path(f.path):
            continue
        for i, line in enumerate(ctx.lines(f.path), start=1):
            if _RAW_SQL.search(line):
                raw_sql_sites.append({"path": f.path, "line": i, "text": line.strip()[:160]})
    stack = ctx.repo.stack or {}
    return {
        "tables": tables,
        "relationships": rel_edges,
        "migrations": migrations,
        "raw_sql_sites": raw_sql_sites[:200],
        "raw_sql_count": len(raw_sql_sites),
        "engines": stack.get("databases", []),
        "table_count": len(tables),
        "orm_tables": sum(1 for t in tables if t["orm"]),
    }


class DatabaseAnalyzer(Analyzer):
    name = "database"
    description = "Orphan tables, missing keys, unguarded bulk writes, raw SQL sprawl."

    async def run(self, ctx: AnalysisContext) -> list[Finding]:
        rep = build_report(ctx)
        out: list[Finding] = []
        for t in rep["tables"]:
            if t["access_count"] == 0 and rep["table_count"] > 1:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="orphan",
                        severity=Severity.LOW,
                        title=f"Table {t['name']} is never queried from code",
                        description="No function references this table in SQL strings or via a detected ORM model access.",
                        path=t["path"],
                        start_line=t["line"],
                        end_line=t["line"],
                        node_id=t["id"],
                        evidence=f"declared in {', '.join(t['declared_in'])}",
                        recommendation="Confirm it is used by another service or drop it (and its migration).",
                        confidence=0.4,
                        tags=["schema"],
                    )
                )
            if t["has_pk"] is False:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="schema",
                        severity=Severity.MEDIUM,
                        title=f"Table {t['name']} has no obvious primary key column",
                        description="Rows without a stable identity cannot be updated or referenced safely.",
                        path=t["path"],
                        start_line=t["line"],
                        end_line=t["line"],
                        node_id=t["id"],
                        evidence=f"columns: {', '.join(t['columns'][:12])}",
                        recommendation="Add a primary key (surrogate id or a natural key).",
                        confidence=0.5,
                        tags=["schema"],
                    )
                )
        for f in ctx.files({"python", "javascript", "typescript", "tsx", "go", "java"}):
            if ctx.is_test_path(f.path):
                continue
            for i, line in enumerate(ctx.lines(f.path), start=1):
                if _DELETE_NO_WHERE.search(line) or _UPDATE_NO_WHERE.search(line):
                    out.append(
                        Finding(
                            analyzer=self.name,
                            category="data-safety",
                            severity=Severity.HIGH,
                            title="Bulk DELETE/UPDATE without WHERE",
                            description="The statement affects every row in the table.",
                            path=f.path,
                            start_line=i,
                            end_line=i,
                            evidence=line.strip()[:200],
                            recommendation="Add a WHERE clause or make the intent explicit (TRUNCATE in a migration).",
                            confidence=0.7,
                            tags=["sql"],
                        )
                    )
        if rep["raw_sql_count"] >= 15 and rep["orm_tables"]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="consistency",
                    severity=Severity.LOW,
                    title=f"Raw SQL in {rep['raw_sql_count']} places alongside an ORM",
                    description="Two data-access styles double the surface for injection and schema drift.",
                    evidence=f"{rep['raw_sql_count']} raw SQL string sites; {rep['orm_tables']} ORM tables",
                    recommendation="Route raw SQL through a small repository layer, or standardise on one style.",
                    confidence=0.5,
                    tags=["sql"],
                )
            )
        return out
