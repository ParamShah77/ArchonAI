"""Capability 17 — engineering health score (0-100) with per-dimension breakdown."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from archon.analysis.base import AnalysisContext
from archon.analysis.findings import SEVERITY_WEIGHT

WEIGHTS = {
    "security": 0.22,
    "performance": 0.12,
    "maintainability": 0.18,
    "architecture": 0.14,
    "dependencies": 0.10,
    "tests": 0.14,
    "complexity": 0.10,
}


def _penalty_score(findings: list[dict[str, Any]], kloc: float, scale: float) -> float:
    """100 minus severity-weighted findings per KLOC, scaled; floors at 0."""
    weight = sum(SEVERITY_WEIGHT.get(f["severity"], 0.1) * float(f.get("confidence", 0.7)) for f in findings)
    per_kloc = weight / max(kloc, 0.5)
    return max(0.0, 100.0 - per_kloc * scale)


def compute_health(ctx: AnalysisContext, findings: list[dict[str, Any]], reports: dict[str, Any]) -> dict[str, Any]:
    kloc = max(ctx.total_lines, 1) / 1000.0
    by_analyzer: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for f in findings:
        if f.get("status", "open") == "open":
            by_analyzer[f["analyzer"]].append(f)
    metrics = ctx.rg.metrics()
    debt = by_analyzer.get("debt", [])
    complexity_findings = [f for f in debt if f["category"] == "complexity"]
    maint_findings = [
        f for f in debt if f["category"] in ("duplication", "dead-code", "design", "structure", "coupling", "todo")
    ]
    arch_findings = (
        [f for f in debt if f["category"] == "architecture"]
        + by_analyzer.get("api", [])
        + by_analyzer.get("database", [])
    )
    tests_rep = reports.get("tests") or {}
    cov = tests_rep.get("coverage_ratio")
    tests_score = 100.0 * cov if cov is not None else 50.0
    tests_score -= min(
        30.0, 3.0 * len([f for f in by_analyzer.get("tests", []) if f["severity"] in ("high", "medium")])
    )
    dims = {
        "security": _penalty_score(by_analyzer.get("security", []), kloc, 6.0),
        "performance": _penalty_score(by_analyzer.get("performance", []), kloc, 5.0),
        "maintainability": _penalty_score(maint_findings, kloc, 5.0),
        "architecture": max(
            0.0, _penalty_score(arch_findings, kloc, 4.0) - 4.0 * len(metrics.get("import_cycles", []))
        ),
        "dependencies": _penalty_score(by_analyzer.get("dependency", []), kloc, 5.0),
        "tests": max(0.0, min(100.0, tests_score)),
        "complexity": _penalty_score(complexity_findings, kloc, 6.0),
    }
    dims = {k: round(v, 1) for k, v in dims.items()}
    score = round(sum(dims[k] * w for k, w in WEIGHTS.items()), 1)
    grade = "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D" if score >= 45 else "F"
    counts = defaultdict(int)
    for f in findings:
        counts[f["severity"]] += 1
    return {
        "score": score,
        "grade": grade,
        "dimensions": dims,
        "weights": WEIGHTS,
        "finding_counts": dict(counts),
        "findings_total": len(findings),
        "kloc": round(kloc, 2),
        "test_coverage_ratio": cov,
        "import_cycles": len(metrics.get("import_cycles", [])),
        "top_issues": sorted(
            findings,
            key=lambda f: (
                ["critical", "high", "medium", "low", "info"].index(f["severity"]),
                -float(f.get("confidence", 0)),
            ),
        )[:8],
    }
