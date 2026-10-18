"""Capability 1 — AI reverse engineering / architecture reconstruction (flow.md §3.3)."""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from archon.db.models import ArchitectureReport, Repository
from archon.db.session import end_read
from archon.graph.model import EdgeKind, NodeKind
from archon.graph.query import RepoGraph
from archon.llm import AI_NOT_CONFIGURED, AI_UNAVAILABLE, LLMError, complete_json, llm_available, public_error
from archon.llm.chain import last_answered_by

log = logging.getLogger("archon.architecture")

_LAYER_HINTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(^|/)(tests?|__tests__|spec|e2e)(/|$)"), "tests"),
    (
        re.compile(r"(^|/)(api|routes?|routers?|controllers?|handlers?|endpoints?|views?|graphql|resolvers?)(/|$)"),
        "interface",
    ),
    (
        re.compile(r"(^|/)(services?|domain|core|usecases?|application|logic|business|workers?|jobs?|tasks?)(/|$)"),
        "application",
    ),
    (
        re.compile(
            r"(^|/)(models?|db|database|repositor(y|ies)|migrations?|schemas?|entities|dao|persistence|prisma)(/|$)"
        ),
        "data",
    ),
    (
        re.compile(r"(^|/)(utils?|lib|libs|common|shared|helpers?|internal|pkg|infra|infrastructure|config)(/|$)"),
        "shared",
    ),
    (
        re.compile(
            r"(^|/)(web|frontend|client|ui|components?|pages|app|public|static|assets|styles?|hooks|store)(/|$)"
        ),
        "frontend",
    ),
    (re.compile(r"(^|/)(cmd|bin|scripts?|cli|tools?)(/|$)"), "entry"),
    (re.compile(r"(^|/)(docs?|examples?|samples?)(/|$)"), "docs"),
]
_ENTRY_FILES = re.compile(
    r"(^|/)(main|app|index|server|cli|manage|wsgi|asgi|application|bootstrap|entry)\.(py|ts|tsx|js|jsx|go|java)$"
)

SYSTEM_PROMPT = (
    "You are ARCHON, a principal software architect reverse-engineering an unfamiliar codebase. "
    "You are given structural facts extracted from the code graph. Reason only from those facts. "
    "Be concrete, name real files/directories, and prefer precise engineering language. Output JSON only."
)


def _layer_for(path: str) -> str:
    for rx, layer in _LAYER_HINTS:
        if rx.search(path):
            return layer
    return "unclassified"


def heuristic_report(repo: Repository, rg: RepoGraph) -> dict[str, Any]:
    nodes, edges = rg.level_view("system")
    comp_nodes = [n for n in nodes if n.kind == NodeKind.DIRECTORY]
    roots = sorted((n.path for n in comp_nodes), key=len, reverse=True)

    def component_of(path: str) -> str:
        for r in roots:
            if path == r or path.startswith(r + "/"):
                return r
        return "(root)"

    files = rg.by_kind(NodeKind.FILE)
    per_dir: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for f in files:
        per_dir[component_of(f.path)]["files"] += 1
    for n in rg.by_kind(NodeKind.FUNCTION, NodeKind.METHOD, NodeKind.CLASS, NodeKind.ENDPOINT, NodeKind.TABLE):
        per_dir[component_of(n.path)][str(n.kind) + "s"] += 1

    id_to_path = {n.id: n.path for n in comp_nodes}
    coupling: dict[str, dict[str, int]] = defaultdict(dict)
    for e in edges:
        if e.kind == EdgeKind.IMPORTS and e.source in id_to_path and e.target in id_to_path:
            coupling[id_to_path[e.source]][id_to_path[e.target]] = e.meta.get("weight", 1)
    components = []
    for d in sorted(comp_nodes, key=lambda n: -per_dir[n.path]["files"]):
        c = per_dir[d.path]
        components.append(
            {
                "name": d.path,
                "layer": _layer_for(d.path),
                "files": c["files"],
                "classes": c.get("classs", 0),
                "functions": c.get("functions", 0) + c.get("methods", 0),
                "endpoints": c.get("endpoints", 0),
                "tables": c.get("tables", 0),
                "imports_from": coupling.get(d.path, {}),
            }
        )
    if "(root)" in per_dir:
        c = per_dir["(root)"]
        components.append(
            {
                "name": "(root)",
                "layer": "entry",
                "files": c["files"],
                "classes": c.get("classs", 0),
                "functions": c.get("functions", 0) + c.get("methods", 0),
                "endpoints": c.get("endpoints", 0),
                "tables": c.get("tables", 0),
                "imports_from": {},
            }
        )

    entry_points = [f.path for f in files if _ENTRY_FILES.search(f.path)]
    endpoint_nodes = rg.by_kind(NodeKind.ENDPOINT)
    endpoints = sorted({n.name for n in endpoint_nodes})
    tables = sorted({n.name for n in rg.by_kind(NodeKind.TABLE)})
    metrics = rg.metrics()
    return {
        "repo": repo.name,
        "stack": repo.stack,
        "components": components,
        "entry_points": entry_points[:25],
        "endpoints": endpoints[:100],
        "endpoint_count": len(endpoint_nodes),
        "tables": tables[:100],
        "metrics": metrics,
        "ai": None,
    }


def _prompt(report: dict[str, Any]) -> str:
    comps = "\n".join(
        f"- {c['name']} [{c['layer']}] files={c['files']} classes={c['classes']} functions={c['functions']} "
        f"endpoints={c['endpoints']} tables={c['tables']} imports_from={c['imports_from']}"
        for c in report["components"][:40]
    )
    return f"""Repository: {report["repo"]}
Tech stack: {report["stack"]}

Top-level components (directory, heuristic layer, sizes, import coupling to other components):
{comps}

Likely entry points: {report["entry_points"]}
Sample API endpoints ({report["endpoint_count"]} total): {report["endpoints"][:40]}
Database tables/models: {report["tables"][:40]}
Most-imported files: {report["metrics"]["most_imported"][:8]}
Import cycles (first 5): {report["metrics"]["import_cycles"][:5]}

Reconstruct the probable architecture. Return JSON with exactly these keys:
{{
  "summary": "2-4 sentence description of what this system is and how it is structured",
  "architecture_style": "e.g. layered monolith, modular monolith, microservices, MVC, hexagonal,
                         frontend SPA + REST API, CLI tool ...",
  "components": [{{"name": "<directory or logical component>", "responsibility": "<one sentence>",
                   "paths": ["<dir>"], "layer": "<interface|application|data|shared|frontend|entry|tests|docs>"}}],
  "data_flow": ["<step 1: request enters at ...>", "<step 2 ...>"],
  "external_systems": ["<databases, queues, third-party APIs inferred from the stack>"],
  "risks": ["<architectural risk or smell backed by the facts above>"],
  "mermaid": "<a mermaid 'flowchart LR' diagram of components and their main dependencies;
              node ids must be alphanumeric>"
}}"""


async def reconstruct(session: AsyncSession, repo: Repository, rg: RepoGraph, refresh: bool = False) -> dict[str, Any]:
    cached = await session.get(ArchitectureReport, repo.id)
    if cached is not None and not refresh and cached.report.get("ai") is not None:
        report = dict(cached.report)
        # reports saved before D-035 may carry provider error text; show the neutral message instead
        if report.get("ai_error") not in (None, AI_NOT_CONFIGURED, AI_UNAVAILABLE):
            report["ai_error"] = AI_UNAVAILABLE
        report.pop("ai_model", None)
        return report
    report = heuristic_report(repo, rg)
    await end_read(session)  # do not hold a read snapshot across the LLM call (D-019)
    if llm_available():
        try:
            report["ai"] = await complete_json(_prompt(report), system=SYSTEM_PROMPT, max_tokens=4096)
            report["ai_model"] = last_answered_by.get() or None
        except (LLMError, Exception) as e:  # noqa: BLE001 - keep heuristic output usable
            log.warning("architecture LLM step failed: %s", e)
            report["ai_error"] = public_error(e)
    else:
        report["ai_error"] = AI_NOT_CONFIGURED
    cached = await session.get(ArchitectureReport, repo.id)
    if cached is None:
        session.add(ArchitectureReport(repo_id=repo.id, report=report))
    else:
        cached.report = report
    await session.commit()
    return report
