"""LLM-driven reasoning workflows (capabilities 4, 7, 10, 15, 16, 18, 19, 20).

Every workflow follows the same shape: gather structural facts + retrieved code (always), then ask the
LLM for a structured JSON answer (when configured). The structural part is returned even without an LLM.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter, defaultdict
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from archon.analysis.base import AnalysisContext
from archon.analysis.security import RULES as SECURITY_RULES
from archon.context.index import graph_facts, retrieve
from archon.db.models import FindingRow, Repository
from archon.graph.model import NodeKind
from archon.graph.query import RepoGraph
from archon.llm.chain import last_answered_by
from archon.services import stacktrace
from archon.services.architecture import heuristic_report, reconstruct
from archon.services.impact import analyze_impact, resolve_target

log = logging.getLogger("archon.reasoning")
SYSTEM = (
    "You are ARCHON, a principal engineer reasoning about ONE specific codebase from the structural facts and code "
    "excerpts provided. Never invent files, functions, or behaviour not supported by the context; when unsure, say so "
    "and name what to check. Output JSON only, matching the requested schema exactly."
)


async def _llm_json(prompt: str, max_tokens: int = 4096) -> tuple[Any | None, str | None]:
    from archon.llm import AI_NOT_CONFIGURED, LLMError, complete_json, llm_available, public_error

    if not llm_available():
        return None, AI_NOT_CONFIGURED
    try:
        return await complete_json(prompt, system=SYSTEM, max_tokens=max_tokens), None
    except (LLMError, Exception) as e:  # noqa: BLE001
        log.warning("reasoning LLM call failed: %s", e)
        return None, public_error(e)


async def _retrieved(
    session: AsyncSession, rg: RepoGraph, repo: Repository, query: str, k: int = 8, budget: int = 14_000
) -> tuple[str, list[dict[str, Any]]]:
    hits = await retrieve(session, rg, repo.id, query, k=k)
    parts, sources, used = [], [], 0
    for h in hits:
        if used >= budget:
            break
        t = h.chunk.text[: budget - used]
        used += len(t)
        parts.append(t)
        sources.append(
            {
                "path": h.chunk.path,
                "start_line": h.chunk.start_line,
                "end_line": h.chunk.end_line,
                "node_id": h.chunk.node_id,
                "name": h.chunk.name,
                "kind": h.chunk.kind,
            }
        )
    return "\n\n".join(parts), sources


def _answered_by(ai: Any) -> str | None:
    """Which chain link produced the AI part (decisions.md D-018); None when there is no AI part."""
    return last_answered_by.get() or None if ai is not None else None


def _node_source(ctx: AnalysisContext, node_id: str, max_lines: int = 120) -> str:
    n = ctx.rg.node(node_id)
    if n is None:
        return ""
    return f"# {n.path}:{n.start_line}-{n.end_line} {n.kind} {n.qualified_name.split('::')[-1]}\n" + ctx.source_of(
        n, max_lines=max_lines
    )


# ----------------------------------------------------------------------------- 4. debugging
async def debug(session: AsyncSession, ctx: AnalysisContext, error_text: str, description: str = "") -> dict[str, Any]:
    rg, repo = ctx.rg, ctx.repo
    pe = stacktrace.resolve_frames(rg, stacktrace.parse(error_text))
    in_repo = [f for f in pe.frames if f.in_repo]
    # innermost repo frame first (Python lists outermost first; JS/Java innermost first)
    ordered = list(reversed(in_repo)) if pe.runtime == "python" else in_repo
    focus_ids = [f.node_id for f in ordered if f.node_id][:4]
    excerpts = [_node_source(ctx, nid) for nid in focus_ids]
    # execution path: callers of the innermost frame + what it calls
    path_facts = graph_facts(rg, focus_ids)
    query = " ".join(filter(None, [pe.error_type, pe.message, description, *(f.node_name for f in ordered[:3])]))
    retrieved, sources = await _retrieved(session, rg, repo, query or error_text[:300], k=6, budget=8000)
    facts = {
        "parsed": pe.to_dict(),
        "focus": [
            {"node_id": f.node_id, "name": f.node_name, "path": f.path, "line": f.line, "kind": f.kind} for f in ordered
        ],
        "graph_facts": path_facts,
    }
    prompt = f"""Error report:
{error_text[:4000]}

User description: {description or "(none)"}

Parsed: runtime={pe.runtime} type={pe.error_type} message={pe.message}
Frames inside the repository (innermost first): {[(f.path, f.line, f.node_name) for f in ordered][:8]}
Graph facts: {path_facts}

Code at the failing frames:
{chr(10).join(excerpts)[:12000]}

Related code (retrieved):
{retrieved}

Return JSON:
{{"summary": "one-paragraph explanation of what failed and why",
  "hypotheses": [{{"title": "...", "likelihood": 0.0-1.0, "evidence": "...", "location": "path:line"}}],
  "root_cause": {{"description": "...", "path": "...", "line": 0, "confidence": 0.0-1.0}},
  "fix": {{"description": "...", "patch": "unified diff or code snippet", "path": "..."}},
  "verification": ["how to reproduce / confirm the fix"],
  "related_risks": ["other places with the same pattern"]}}"""
    ai, err = await _llm_json(prompt)
    return {"facts": facts, "sources": sources, "ai": ai, "ai_error": err, "ai_model": _answered_by(ai)}


# ----------------------------------------------------------------------------- 8. impact (+ AI summary)
async def impact(
    session: AsyncSession,
    ctx: AnalysisContext,
    node_id: str | None,
    path: str | None,
    symbol: str | None,
    depth: int,
    change: str,
    with_ai: bool,
) -> dict[str, Any]:
    target = resolve_target(ctx.rg, node_id, path, symbol)
    if target is None:
        return {"error": "target not found"}
    rep = analyze_impact(ctx.rg, target, depth=depth)
    if not with_ai:
        return rep
    prompt = f"""A developer wants to change `{rep["target"]["name"]}` ({rep["target"]["kind"]} in {rep["target"]["path"]}).
Described change: {change or "(unspecified)"}

Source of the target:
{_node_source(ctx, target.id, 150)[:6000]}

Dependents (upstream) from the graph: {json.dumps({k: [r["name"] for r in v[:15]] for k, v in rep["upstream"].items()})}
Dependencies (downstream): {json.dumps({k: [r["name"] for r in v[:15]] for k, v in rep["downstream"].items()})}
Risk score {rep["risk"]["score"]} ({rep["risk"]["level"]}): {rep["risk"]["reasons"]}

Return JSON:
{{"summary": "...", "will_break": [{{"what": "...", "why": "...", "path": "..."}}], "safe_if": ["conditions under which the change is safe"],
  "tests_to_run": ["..."], "migration_steps": ["ordered steps to make the change safely"], "confidence": 0.0-1.0}}"""
    ai, err = await _llm_json(prompt, max_tokens=2500)
    rep["ai"], rep["ai_error"], rep["ai_model"] = ai, err, _answered_by(ai)
    return rep


# ----------------------------------------------------------------------------- 18. feature simulator / 20. planner
async def plan_feature(
    session: AsyncSession, ctx: AnalysisContext, description: str, mode: str = "plan"
) -> dict[str, Any]:
    rg, repo = ctx.rg, ctx.repo
    retrieved, sources = await _retrieved(session, rg, repo, description, k=10, budget=14000)
    arch = heuristic_report(repo, rg)
    # heuristic affected components: components owning the retrieved sources
    comp_hits: Counter[str] = Counter()
    for s in sources:
        for c in arch["components"]:
            if c["name"] != "(root)" and (s["path"] == c["name"] or s["path"].startswith(c["name"] + "/")):
                comp_hits[c["name"]] += 1
    endpoints = [e for e in rg.by_kind(NodeKind.ENDPOINT)]
    tables = [t.name for t in rg.by_kind(NodeKind.TABLE)]
    facts = {
        "likely_components": [{"name": k, "hits": v} for k, v in comp_hits.most_common(6)],
        "relevant_code": sources,
        "existing_endpoints_sample": [e.name for e in endpoints[:40]],
        "tables": tables[:40],
        "stack": repo.stack,
    }
    schema = (
        '{"summary": "...", "affected_components": [{"name": "...", "why": "...", "change_type": "modify|create"}], '
        '"files_to_modify": [{"path": "...", "what": "..."}], "new_files": [{"path": "...", "purpose": "..."}], '
        '"database_changes": [{"table": "...", "change": "..."}], "api_changes": [{"method": "...", "route": "...", "change": "..."}], '
        '"dependencies": ["..."], "tests": ["..."], "security": ["..."], "deployment": ["..."], '
        '"steps": [{"order": 1, "title": "...", "details": "...", "files": ["..."]}], '
        '"complexity": {"level": "S|M|L|XL", "estimate_days": 0, "rationale": "..."}, "risks": ["..."]}'
    )
    task = (
        "Produce a complete implementation plan."
        if mode == "plan"
        else "Simulate the feature: identify exactly which existing parts must change and what new parts are needed."
    )
    prompt = f"""Feature request: {description}

Repository: {repo.name}; stack: {repo.stack}
Components: {[(c["name"], c["layer"], c["files"]) for c in arch["components"][:20]]}
Existing endpoints (sample): {facts["existing_endpoints_sample"]}
Tables: {facts["tables"]}
Most relevant existing code:
{retrieved}

{task} Return JSON exactly: {schema}"""
    ai, err = await _llm_json(prompt, max_tokens=4096)
    return {"facts": facts, "ai": ai, "ai_error": err, "ai_model": _answered_by(ai)}


# ----------------------------------------------------------------------------- 7. architecture advisor
async def advise(session: AsyncSession, ctx: AnalysisContext, question: str) -> dict[str, Any]:
    rg, repo = ctx.rg, ctx.repo
    arch = await reconstruct(session, repo, rg)
    findings = list(
        (
            await session.execute(
                select(FindingRow)
                .where(FindingRow.repo_id == repo.id, FindingRow.status == "open")
                .order_by(FindingRow.severity)
                .limit(40)
            )
        ).scalars()
    )
    retrieved, sources = await _retrieved(session, rg, repo, question, k=6, budget=8000)
    prompt = f"""Question from the team: {question}

Architecture (reconstructed): style={arch.get("ai", {}).get("architecture_style") if arch.get("ai") else "unknown"}
Summary: {arch.get("ai", {}).get("summary") if arch.get("ai") else "(no AI summary)"}
Components: {[(c["name"], c["layer"], c["files"], c["endpoints"], c["tables"]) for c in arch["components"][:20]]}
Stack: {repo.stack}
Metrics: cycles={len(arch["metrics"]["import_cycles"])}, most_imported={arch["metrics"]["most_imported"][:5]}
Open findings (top): {[(f.analyzer, f.severity, f.title) for f in findings[:25]]}
Relevant code:
{retrieved}

Return JSON:
{{"assessment": "current state relative to the question",
  "recommendations": [{{"title": "...", "rationale": "...", "impact": "high|medium|low", "effort": "S|M|L|XL", "steps": ["..."], "affects": ["component or path"]}}],
  "alternatives": [{{"option": "...", "pros": ["..."], "cons": ["..."], "when": "..."}}],
  "tradeoffs": "...", "quick_wins": ["..."], "long_term": ["..."]}}"""
    ai, err = await _llm_json(prompt)
    return {
        "facts": {
            "components": arch["components"][:20],
            "findings": [
                {"analyzer": f.analyzer, "severity": f.severity, "title": f.title, "path": f.path}
                for f in findings[:25]
            ],
        },
        "sources": sources,
        "ai": ai,
        "ai_error": err,
        "ai_model": _answered_by(ai),
    }


# ----------------------------------------------------------------------------- 19. refactoring
async def refactor(
    session: AsyncSession, ctx: AnalysisContext, node_id: str | None, path: str | None
) -> dict[str, Any]:
    rg, repo = ctx.rg, ctx.repo
    q = select(FindingRow).where(
        FindingRow.repo_id == repo.id, FindingRow.analyzer == "debt", FindingRow.status == "open"
    )
    if path:
        q = q.where(FindingRow.path == path)
    debt = list((await session.execute(q)).scalars())
    target = rg.node(node_id) if node_id else None
    if target is None and debt:
        # pick the hottest file by weighted findings
        weights: Counter[str] = Counter()
        for f in debt:
            weights[f.path] += {"critical": 10, "high": 5, "medium": 2, "low": 1, "info": 0.2}[f.severity]
        hot = weights.most_common(1)[0][0]
        target = next((n for n in rg.by_kind(NodeKind.FILE) if n.path == hot), None)
    if target is None:
        # no debt findings yet: fall back to the longest non-test callable, the usual first refactoring candidate
        cands = [n for n in rg.by_kind(NodeKind.FUNCTION, NodeKind.METHOD) if not AnalysisContext.is_test_path(n.path)]
        target = max(cands, key=lambda n: n.end_line - n.start_line, default=None)
    if target is None:
        return {"error": "no refactoring target: the repository has no functions"}
    imp = analyze_impact(rg, target, depth=2)
    relevant = [f for f in debt if f.path == target.path]
    prompt = f"""Refactoring target: {target.qualified_name.split("::")[-1]} ({target.kind}, {target.path})
Debt findings on it: {[(f.severity, f.title, f.start_line) for f in relevant[:20]]}
Dependents that must keep working: {[r["name"] for r in imp["upstream"]["functions"][:15]]} ; endpoints: {[r["name"] for r in imp["upstream"]["endpoints"][:10]]} ; tests: {[r["path"] for r in imp["upstream"]["tests"][:10]]}

Source:
{_node_source(ctx, target.id, 220)[:12000]}

Return JSON:
{{"summary": "...", "proposals": [{{"title": "...", "type": "extract|rename|split|inline|introduce-abstraction|remove|reorder", "rationale": "...", "before": "...", "after": "...", "risk": "low|medium|high", "steps": ["..."], "preserves_behaviour_because": "..."}}],
  "order": ["proposal titles in a safe order"], "safety_net": ["tests to add before refactoring"]}}"""
    ai, err = await _llm_json(prompt)
    return {
        "target": imp["target"],
        "findings": [
            {"severity": f.severity, "title": f.title, "line": f.start_line, "category": f.category} for f in relevant
        ],
        "impact": imp["risk"],
        "ai": ai,
        "ai_error": err,
        "ai_model": _answered_by(ai),
    }


# ----------------------------------------------------------------------------- 10. test generation
async def generate_tests(session: AsyncSession, ctx: AnalysisContext, node_id: str) -> dict[str, Any]:
    rg, repo = ctx.rg, ctx.repo
    n = rg.node(node_id)
    if n is None:
        return {"error": "node not found"}
    callees = [rg.nodes[t] for t, d in rg.out_edges(n.id) if d["kind"] == "calls" and t in rg.nodes]
    callers = [rg.nodes[s] for s, d in rg.in_edges(n.id) if d["kind"] == "calls" and s in rg.nodes]
    framework = ", ".join((repo.stack or {}).get("testing", [])) or (
        "pytest" if n.language == "python" else "vitest/jest"
    )
    existing = [f.path for f in rg.by_kind(NodeKind.FILE) if AnalysisContext.is_test_path(f.path)][:5]
    prompt = f"""Write tests for `{n.qualified_name.split("::")[-1]}` ({n.kind}, {n.language}) in {n.path}:{n.start_line}-{n.end_line}.
Test framework in this repo: {framework}. Existing test files (style reference): {existing}
It calls: {[c.name for c in callees][:12]}; called by: {[c.name for c in callers][:8]}

Source:
{_node_source(ctx, n.id, 200)[:9000]}
Callee sources (for mocking decisions):
{chr(10).join(_node_source(ctx, c.id, 40) for c in callees[:4])[:5000]}

Return JSON:
{{"test_file_path": "suggested path", "cases": [{{"name": "...", "kind": "happy|edge|error|regression", "covers": "...", "priority": "high|medium|low"}}],
  "code": "complete test file content", "mocks": ["what to mock and why"], "notes": ["..."]}}"""
    ai, err = await _llm_json(prompt, max_tokens=4096)
    heuristic_cases = _heuristic_cases(ctx, n)
    return {
        "target": {"id": n.id, "name": n.qualified_name.split("::")[-1], "path": n.path, "line": n.start_line},
        "heuristic_cases": heuristic_cases,
        "ai": ai,
        "ai_error": err,
        "ai_model": _answered_by(ai),
    }


def _heuristic_cases(ctx: AnalysisContext, n) -> list[dict[str, str]]:
    src = ctx.source_of(n, 300)
    cases = [{"name": f"test_{n.name}_happy_path", "kind": "happy", "covers": "typical input returns expected result"}]
    params = str(n.meta.get("params", "")).strip("()")
    for p in [x.strip().split(":")[0].split("=")[0].strip() for x in params.split(",") if x.strip()][:5]:
        if p in ("self", "cls"):
            continue
        cases.append({"name": f"test_{n.name}_invalid_{p}", "kind": "edge", "covers": f"invalid/empty `{p}`"})
    if re.search(r"\braise\b|\bthrow\b", src):
        cases.append(
            {"name": f"test_{n.name}_raises", "kind": "error", "covers": "error branch raises the expected exception"}
        )
    if re.search(r"\bif\b.*\bNone\b|== null|=== undefined|\?\.", src):
        cases.append({"name": f"test_{n.name}_missing_value", "kind": "edge", "covers": "None/undefined handling"})
    if re.search(r"\bfor\b|\bwhile\b|\.map\(|forEach", src):
        cases.append({"name": f"test_{n.name}_empty_collection", "kind": "edge", "covers": "empty iterable input"})
    return cases


# ----------------------------------------------------------------------------- 16. code review
_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def parse_diff(diff: str) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    new_line = 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            path = line[4:].strip()
            path = path[2:] if path.startswith("b/") else path
            cur = {"path": path, "added": [], "removed": [], "hunks": 0}
            files.append(cur)
        elif line.startswith("--- ") or line.startswith("diff ") or line.startswith("index "):
            continue
        elif cur is not None and (m := _HUNK.match(line)):
            new_line = int(m.group(3))
            cur["hunks"] += 1
        elif cur is not None and line.startswith("+"):
            cur["added"].append((new_line, line[1:]))
            new_line += 1
        elif cur is not None and line.startswith("-"):
            cur["removed"].append(line[1:])
        elif cur is not None and not line.startswith("\\"):
            new_line += 1
    return files


async def review(session: AsyncSession, ctx: AnalysisContext, diff: str, title: str = "") -> dict[str, Any]:
    rg = ctx.rg
    files = parse_diff(diff)
    if not files:
        return {"error": "no files parsed from the diff (expected unified diff with +++/--- headers)"}
    changed_symbols: list[dict[str, Any]] = []
    quick: list[dict[str, Any]] = []
    for f in files:
        lines = {ln for ln, _ in f["added"]}
        lang = next((n.language for n in rg.by_kind(NodeKind.FILE) if n.path == f["path"]), "")
        for n in rg.nodes.values():
            if (
                n.path == f["path"]
                and n.kind in (NodeKind.FUNCTION, NodeKind.METHOD, NodeKind.CLASS)
                and any(n.start_line <= ln <= n.end_line for ln in lines)
            ):
                imp = analyze_impact(rg, n, depth=2)
                changed_symbols.append(
                    {
                        "node_id": n.id,
                        "name": n.qualified_name.split("::")[-1],
                        "kind": str(n.kind),
                        "path": n.path,
                        "callers": imp["direct_dependents"],
                        "endpoints": [e["name"] for e in imp["upstream"]["endpoints"][:5]],
                        "tests": [t["path"] for t in imp["upstream"]["tests"][:5]],
                        "risk": imp["risk"]["level"],
                    }
                )
        for ln, text in f["added"]:
            for rule in SECURITY_RULES:
                if lang in rule.languages and rule.pattern.search(text):
                    quick.append(
                        {
                            "path": f["path"],
                            "line": ln,
                            "severity": str(rule.severity),
                            "rule": rule.id,
                            "title": rule.title,
                            "evidence": text.strip()[:160],
                            "recommendation": rule.recommendation,
                        }
                    )
            if re.search(r"\b(console\.log|print\(|debugger;|pdb\.set_trace|breakpoint\(\))", text):
                quick.append(
                    {
                        "path": f["path"],
                        "line": ln,
                        "severity": "low",
                        "rule": "REV-DEBUG-LEFTOVER",
                        "title": "Debug statement left in code",
                        "evidence": text.strip()[:160],
                        "recommendation": "Remove before merging.",
                    }
                )
    symbols_ctx = "\n\n".join(_node_source(ctx, s["node_id"], 120) for s in changed_symbols[:6])[:12000]
    prompt = f"""Review this change{(" titled: " + title) if title else ""}.

Diff:
{diff[:16000]}

Changed symbols with graph context (callers, reachable endpoints, covering tests, risk): {json.dumps(changed_symbols[:12])}
Current source of changed symbols (post-change file state may differ):
{symbols_ctx}

Return JSON:
{{"summary": "...", "verdict": "approve|request_changes|comment",
  "findings": [{{"path": "...", "line": 0, "severity": "critical|high|medium|low|info", "category": "bug|regression|security|performance|maintainability|style|test", "title": "...", "explanation": "...", "suggestion": "..."}}],
  "side_effects": ["unintended effects given the callers/endpoints above"], "missing_tests": ["..."], "praise": ["..."]}}"""
    ai, err = await _llm_json(prompt)
    return {
        "files": [
            {"path": f["path"], "added": len(f["added"]), "removed": len(f["removed"]), "hunks": f["hunks"]}
            for f in files
        ],
        "changed_symbols": changed_symbols,
        "quick_findings": quick,
        "ai": ai,
        "ai_error": err,
        "ai_model": _answered_by(ai),
    }


# ----------------------------------------------------------------------------- 15. incident & log intelligence
_TS = re.compile(
    r"(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)|(\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2})"
)
_LEVEL = re.compile(r"\b(CRITICAL|FATAL|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE|PANIC)\b", re.IGNORECASE)
_MASK = [
    (re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I), "<uuid>"),
    (re.compile(r"0x[0-9a-f]+", re.I), "<hex>"),
    (re.compile(r"\b\d+\.\d+\.\d+\.\d+\b"), "<ip>"),
    (re.compile(r"\b\d+\b"), "<n>"),
    (re.compile(r"'[^']*'|\"[^\"]*\""), "<str>"),
]


def _template(msg: str) -> str:
    t = msg
    for rx, rep in _MASK:
        t = rx.sub(rep, t)
    return t.strip()[:160]


def analyze_logs(text: str, rg: RepoGraph) -> dict[str, Any]:
    entries = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        ts = _TS.search(raw)
        lvl = _LEVEL.search(raw)
        level = (
            (lvl.group(1).upper() if lvl else "INFO")
            .replace("ERR", "ERROR")
            .replace("ERROROR", "ERROR")
            .replace("WARNING", "WARN")
        )
        msg = raw
        if ts:
            msg = msg.replace(ts.group(0), "", 1)
        if lvl:
            msg = msg.replace(lvl.group(0), "", 1)
        entries.append({"ts": ts.group(0) if ts else None, "level": level, "msg": msg.strip(" -[]|:"), "raw": raw})
    templates: dict[str, dict[str, Any]] = {}
    for e in entries:
        t = _template(e["msg"])
        d = templates.setdefault(
            t,
            {
                "template": t,
                "count": 0,
                "levels": Counter(),
                "first": e["ts"],
                "last": e["ts"],
                "example": e["raw"][:200],
            },
        )
        d["count"] += 1
        d["levels"][e["level"]] += 1
        d["last"] = e["ts"] or d["last"]
    clusters = sorted(
        ({**v, "levels": dict(v["levels"])} for v in templates.values()),
        key=lambda x: (-x["levels"].get("ERROR", 0) - x["levels"].get("CRITICAL", 0) * 2, -x["count"]),
    )
    # timeline in minute buckets
    buckets: dict[str, Counter[str]] = defaultdict(Counter)
    for e in entries:
        if e["ts"]:
            key = e["ts"][:16]
            buckets[key][e["level"]] += 1
    timeline = [{"minute": k, **dict(v)} for k, v in sorted(buckets.items())]
    error_minutes = [t for t in timeline if (t.get("ERROR", 0) + t.get("CRITICAL", 0)) > 0]
    bursts = []
    if error_minutes:
        peak = max(error_minutes, key=lambda t: t.get("ERROR", 0) + t.get("CRITICAL", 0))
        bursts.append({"minute": peak["minute"], "errors": peak.get("ERROR", 0) + peak.get("CRITICAL", 0)})
    # code references
    pe = stacktrace.resolve_frames(rg, stacktrace.parse(text))
    code_refs = [
        {"path": f.path, "line": f.line, "node": f.node_name, "node_id": f.node_id} for f in pe.frames if f.in_repo
    ][:20]
    levels = Counter(e["level"] for e in entries)
    return {
        "entries": len(entries),
        "levels": dict(levels),
        "clusters": clusters[:40],
        "timeline": timeline[:500],
        "bursts": bursts,
        "code_refs": code_refs,
        "first_ts": next((e["ts"] for e in entries if e["ts"]), None),
        "last_ts": next((e["ts"] for e in reversed(entries) if e["ts"]), None),
    }


async def incident(session: AsyncSession, ctx: AnalysisContext, logs: str, description: str = "") -> dict[str, Any]:
    rg, repo = ctx.rg, ctx.repo
    facts = analyze_logs(logs, rg)
    focus_ids = [r["node_id"] for r in facts["code_refs"] if r["node_id"]][:4]
    excerpts = "\n\n".join(_node_source(ctx, nid, 80) for nid in focus_ids)[:8000]
    top_err = [c["template"] for c in facts["clusters"] if c["levels"].get("ERROR") or c["levels"].get("CRITICAL")][:8]
    retrieved, sources = await _retrieved(
        session, rg, repo, " ".join(top_err)[:500] or description or logs[:300], k=5, budget=6000
    )
    prompt = f"""Incident logs ({facts["entries"]} lines, levels {facts["levels"]}, span {facts["first_ts"]} → {facts["last_ts"]}).
User description: {description or "(none)"}
Top error templates: {top_err}
Error bursts: {facts["bursts"]}
Code referenced by the logs: {facts["code_refs"][:10]}
Graph facts: {graph_facts(rg, focus_ids)}

Code at referenced locations:
{excerpts}

Related code (retrieved):
{retrieved}

Return JSON:
{{"summary": "what happened, in 2-3 sentences", "timeline": [{{"time": "...", "event": "..."}}], "correlated_failures": ["..."],
  "root_cause": {{"description": "...", "confidence": 0.0-1.0, "path": "...", "line": 0}}, "hypotheses": [{{"title": "...", "likelihood": 0.0-1.0, "evidence": "..."}}],
  "remediation": ["immediate"], "prevention": ["long term"], "suspicious_patterns": ["..."]}}"""
    ai, err = await _llm_json(prompt)
    return {
        "facts": facts,
        "sources": sources,
        "ai": ai,
        "ai_error": err,
        "ai_model": _answered_by(ai),
        "analyzed_at": datetime.now().isoformat(timespec="seconds"),
    }
