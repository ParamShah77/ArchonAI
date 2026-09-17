"""Capability 10 — test intelligence (heuristic part): test inventory, coverage gaps, risky untested paths."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from archon.analysis.base import AnalysisContext, Analyzer
from archon.analysis.findings import Finding, Severity
from archon.graph.model import EdgeKind, NodeKind

_TEST_FN = re.compile(r"^(test_|test[A-Z]|it_|should)|Test$|Spec$")


def build_report(ctx: AnalysisContext) -> dict[str, Any]:
    rg = ctx.rg
    files = rg.by_kind(NodeKind.FILE)
    test_files = [f for f in files if ctx.is_test_path(f.path)]
    src_files = [
        f
        for f in files
        if not ctx.is_test_path(f.path) and f.language in ("python", "javascript", "typescript", "tsx", "go", "java")
    ]
    tested: dict[str, set[str]] = defaultdict(set)  # source path -> test paths
    for tf in test_files:
        for t, _ in rg.out_edges(tf.id, EdgeKind.IMPORTS):
            tn = rg.nodes.get(t)
            if tn is not None and tn.kind == NodeKind.FILE and not ctx.is_test_path(tn.path):
                tested[tn.path].add(tf.path)
        # name-based fallback: tests/test_foo.py ↔ foo.py
        stem = re.sub(r"^(test_)|(_test|\.test|\.spec|_spec|Test)$", "", tf.name.rsplit(".", 1)[0])
        for sf in src_files:
            if sf.name.rsplit(".", 1)[0] == stem and stem:
                tested[sf.path].add(tf.path)
    test_cases = 0
    for tf in test_files:
        for n in rg.by_kind(NodeKind.FUNCTION, NodeKind.METHOD):
            if n.path == tf.path and _TEST_FN.search(n.name):
                test_cases += 1
        text = ctx.read(tf.path) or ""
        test_cases += len(re.findall(r"\b(it|test)\(\s*[\"'`]", text))
    fan_in: dict[str, int] = defaultdict(int)
    for e in rg.edges:
        if e.kind == EdgeKind.CALLS:
            fan_in[e.target] += 1
    untested_files = [f for f in src_files if f.path not in tested]
    risky: list[dict[str, Any]] = []
    for fn in rg.by_kind(NodeKind.FUNCTION, NodeKind.METHOD):
        if ctx.is_test_path(fn.path) or fn.path in tested:
            continue
        exposes = any(d["kind"] == "exposes" for _, d in rg.out_edges(fn.id))
        queries = any(d["kind"] == "queries" for _, d in rg.out_edges(fn.id))
        score = (
            fan_in[fn.id] * 2
            + (5 if exposes else 0)
            + (3 if queries else 0)
            + max(0, (fn.end_line - fn.start_line) // 25)
        )
        if score >= 4:
            risky.append(
                {
                    "id": fn.id,
                    "name": fn.qualified_name.split("::")[-1],
                    "path": fn.path,
                    "line": fn.start_line,
                    "score": score,
                    "callers": fan_in[fn.id],
                    "endpoint": exposes,
                    "queries_db": queries,
                }
            )
    risky.sort(key=lambda r: -r["score"])
    return {
        "test_files": len(test_files),
        "test_cases": test_cases,
        "source_files": len(src_files),
        "covered_files": len([f for f in src_files if f.path in tested]),
        "coverage_ratio": (len([f for f in src_files if f.path in tested]) / len(src_files)) if src_files else None,
        "untested_files": [f.path for f in untested_files][:200],
        "risky_untested": risky[:50],
        "frameworks": (ctx.repo.stack or {}).get("testing", []),
        "map": {k: sorted(v) for k, v in sorted(tested.items())},
    }


class TestAnalyzer(Analyzer):
    name = "tests"
    description = "Missing coverage on endpoints, hubs and data-access code."

    async def run(self, ctx: AnalysisContext) -> list[Finding]:
        rep = build_report(ctx)
        out: list[Finding] = []
        if rep["source_files"] and rep["test_files"] == 0:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="coverage",
                    severity=Severity.HIGH,
                    title="No tests found",
                    description="No test files were detected in the repository.",
                    evidence=f"{rep['source_files']} source files, 0 test files",
                    recommendation="Start with tests for endpoints and data-access functions (see risky list).",
                    confidence=0.85,
                    tags=["tests"],
                )
            )
        for r in rep["risky_untested"][:25]:
            sev = Severity.MEDIUM if r["endpoint"] or r["callers"] >= 5 else Severity.LOW
            why = []
            if r["endpoint"]:
                why.append("exposes an endpoint")
            if r["queries_db"]:
                why.append("touches the database")
            if r["callers"]:
                why.append(f"called from {r['callers']} places")
            out.append(
                Finding(
                    analyzer=self.name,
                    category="coverage",
                    severity=sev,
                    title=f"Untested: {r['name']}",
                    description="No test file imports or names this module; the function " + ", ".join(why) + ".",
                    path=r["path"],
                    start_line=r["line"],
                    end_line=r["line"],
                    node_id=r["id"],
                    evidence=f"risk score {r['score']}",
                    recommendation="Add a unit test for the main path and one for each failure branch.",
                    confidence=0.55,
                    tags=["tests"],
                )
            )
        return out
