"""Capability 11 — automated documentation. Heuristic markdown always; LLM narrative when available."""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from archon.analysis import api_intel, db_intel, dependency
from archon.analysis.base import AnalysisContext
from archon.db.models import Document, Repository
from archon.graph.model import EdgeKind, NodeKind
from archon.llm import LLMError, complete, llm_available
from archon.services.architecture import heuristic_report

log = logging.getLogger("archon.docs")

KINDS = ["architecture", "api", "modules", "dataflow", "database", "dependencies", "setup", "onboarding"]
SYSTEM = "You are a senior engineer writing crisp, accurate technical documentation from structural facts. Use Markdown. Never invent APIs or files that are not in the facts."


async def _narrate(title: str, facts: str, ask: str, max_tokens: int = 1800) -> str | None:
    if not llm_available():
        return None
    try:
        return await complete(
            f"# {title}\n\nFacts:\n{facts[:16000]}\n\nTask: {ask}", system=SYSTEM, max_tokens=max_tokens
        )
    except (LLMError, Exception) as e:  # noqa: BLE001
        log.warning("docs narration failed: %s", e)
        return None


def _md_table(headers: list[str], rows: list[list[Any]]) -> str:
    if not rows:
        return "_none_\n"
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(c).replace("|", "\\|") for c in r) + " |" for r in rows]
    return "\n".join(out) + "\n"


async def gen_architecture(ctx: AnalysisContext) -> tuple[str, bool]:
    rep = heuristic_report(ctx.repo, ctx.rg)
    stack = ctx.repo.stack or {}
    md = [f"# {ctx.repo.name} — Architecture\n", "## Technology stack\n"]
    for k in ("languages", "frameworks", "databases", "auth", "infra", "ci", "testing", "tooling"):
        v = stack.get(k)
        if v:
            md.append(f"- **{k.title()}**: " + ", ".join(x["name"] if isinstance(x, dict) else str(x) for x in v))
    md.append("\n## Components\n")
    md.append(
        _md_table(
            ["Component", "Layer", "Files", "Functions", "Endpoints", "Tables", "Imports from"],
            [
                [
                    c["name"],
                    c["layer"],
                    c["files"],
                    c["functions"],
                    c["endpoints"],
                    c["tables"],
                    ", ".join(f"{k} ({v})" for k, v in c["imports_from"].items()),
                ]
                for c in rep["components"]
            ],
        )
    )
    md.append("\n## Entry points\n" + "\n".join(f"- `{p}`" for p in rep["entry_points"]) + "\n")
    m = rep["metrics"]
    md.append(
        "\n## Structural metrics\n"
        + _md_table(
            ["Metric", "Value"],
            [
                ["Files", m["files"]],
                ["Functions", m["functions"]],
                ["Classes", m["classes"]],
                ["Endpoints", m["endpoints"]],
                ["Tables", m["tables"]],
                ["Import cycles", len(m["import_cycles"])],
            ],
        )
    )
    md.append(
        "\n### Most imported files\n" + "\n".join(f"- `{x['path']}` ({x['fan_in']})" for x in m["most_imported"]) + "\n"
    )
    facts = "\n".join(md)
    narrative = await _narrate(
        "Architecture overview",
        facts,
        "Write an 'Overview' section (2-4 paragraphs) describing what the system is, its architectural style, how components collaborate, and notable risks. Then a 'Request lifecycle' section as an ordered list.",
    )
    if narrative:
        return f"# {ctx.repo.name} — Architecture\n\n{narrative}\n\n" + "\n".join(md[1:]), True
    return facts, False


async def gen_api(ctx: AnalysisContext) -> tuple[str, bool]:
    rep = api_intel.build_report(ctx)
    md = [
        f"# {ctx.repo.name} — API reference\n",
        f"{rep['count']} endpoints. Auth coverage (heuristic): {round((rep['auth_coverage'] or 0) * 100)}%.\n",
    ]
    by_res: dict[str, list[dict]] = defaultdict(list)
    for e in rep["endpoints"]:
        by_res[e["resource"]].append(e)
    for res, eps in sorted(by_res.items()):
        md.append(f"\n## {res}\n")
        for e in eps:
            md.append(f"### `{e['method']} {e['route']}`\n")
            md.append(f"- Handler: `{e['handler']}{e['params']}` — `{e['path']}:{e['line']}`")
            md.append(f"- Auth: {'yes' if e['auth'] else 'not detected'}")
            if e["path_params"]:
                md.append(f"- Path params: {', '.join('`' + p + '`' for p in e['path_params'])}")
            if e["reaches_tables"]:
                md.append(f"- Touches tables: {', '.join('`' + t + '`' for t in e['reaches_tables'])}")
            if e["calls"]:
                md.append(f"- Calls: {', '.join('`' + c + '`' for c in e['calls'][:10])}")
            md.append("")
    facts = "\n".join(md)
    narrative = await _narrate(
        "API reference",
        facts,
        "For each endpoint, write one sentence describing its purpose inferred from the handler name, params and tables. Output a Markdown list `- METHOD /route — purpose`.",
    )
    if narrative:
        return facts + "\n\n## Endpoint purposes (AI)\n\n" + narrative, True
    return facts, False


async def gen_modules(ctx: AnalysisContext) -> list[tuple[str, str, str, bool]]:
    """One document per component root: (subject, title, markdown, ai)."""
    out = []
    for comp in ctx.rg.component_roots():
        files = [f for f in ctx.rg.by_kind(NodeKind.FILE) if f.path == comp.path or f.path.startswith(comp.path + "/")]
        md = [f"# Module `{comp.path}`\n", f"{len(files)} files.\n", "## Files\n"]
        for f in sorted(files, key=lambda x: x.path)[:150]:
            syms = [ctx.rg.nodes[t] for t, d in ctx.rg.out_edges(f.id, EdgeKind.CONTAINS) if t in ctx.rg.nodes]
            names = ", ".join(f"`{s.name}`" for s in syms[:12] if s.kind in (NodeKind.CLASS, NodeKind.FUNCTION))
            imports = [
                ctx.rg.nodes[t].path
                for t, d in ctx.rg.out_edges(f.id, EdgeKind.IMPORTS)
                if t in ctx.rg.nodes and ctx.rg.nodes[t].kind == NodeKind.FILE
            ]
            md.append(
                f"- `{f.path}`"
                + (f" — {names}" if names else "")
                + (f"\n  - imports: {', '.join('`' + i + '`' for i in imports[:8])}" if imports else "")
            )
        facts = "\n".join(md)
        narrative = await _narrate(
            f"Module {comp.path}",
            facts,
            "Write a 'Responsibility' paragraph and a 'Key files' bullet list (file → one-line purpose) for this module.",
            max_tokens=1200,
        )
        content = (f"# Module `{comp.path}`\n\n{narrative}\n\n" + "\n".join(md[1:])) if narrative else facts
        out.append((comp.path, f"Module: {comp.path}", content, bool(narrative)))
    return out


async def gen_dataflow(ctx: AnalysisContext) -> tuple[str, bool]:
    rep = api_intel.build_report(ctx)
    md = [f"# {ctx.repo.name} — Data flow\n", "Request → handler → services → tables, derived from the call graph.\n"]
    md.append("```mermaid\nflowchart LR\n")
    seen = set()
    for e in rep["endpoints"][:60]:
        ep_id = f"E{abs(hash(e['route'] + e['method'])) % 10**6}"
        md.append(f'  {ep_id}["{e["method"]} {e["route"]}"]')
        h_id = "H" + (e["handler_id"] or ep_id)
        md.append(f'  {h_id}["{e["handler"]}"]')
        md.append(f"  {ep_id} --> {h_id}")
        for t in e["reaches_tables"][:6]:
            t_id = "T" + t
            if t_id not in seen:
                md.append(f'  {t_id}[("{t}")]')
                seen.add(t_id)
            md.append(f"  {h_id} --> {t_id}")
    md.append("```\n")
    md.append(
        "\n## Endpoint → tables\n"
        + _md_table(
            ["Endpoint", "Handler", "Tables", "Depth"],
            [
                [f"{e['method']} {e['route']}", e["handler"], ", ".join(e["reaches_tables"]) or "-", e["depth"]]
                for e in rep["endpoints"]
            ],
        )
    )
    facts = "\n".join(md)
    narrative = await _narrate(
        "Data flow",
        facts,
        "Describe the 3-5 most important end-to-end flows as numbered steps (request enters → validation → business logic → persistence → response).",
    )
    if narrative:
        return facts + "\n\n## Key flows (AI)\n\n" + narrative, True
    return facts, False


async def gen_database(ctx: AnalysisContext) -> tuple[str, bool]:
    rep = db_intel.build_report(ctx)
    md = [
        f"# {ctx.repo.name} — Database\n",
        f"Engines: {', '.join(rep['engines']) or 'unknown'}. {rep['table_count']} tables ({rep['orm_tables']} via ORM). {len(rep['migrations'])} migration files.\n",
    ]
    if rep["relationships"]:
        md.append(
            "```mermaid\nerDiagram\n"
            + "\n".join(f"  {r['to']} ||--o{{ {r['from']} : has" for r in rep["relationships"])
            + "\n```\n"
        )
    for t in rep["tables"]:
        md.append(f"\n## `{t['name']}`\n")
        md.append(
            f"- Declared in: {', '.join('`' + p + '`' for p in t['declared_in'])}"
            + (f" (models: {', '.join(t['models'])})" if t["models"] else "")
        )
        if t["columns"]:
            md.append(f"- Columns: {', '.join('`' + c + '`' for c in t['columns'])}")
        if t["references"]:
            md.append(f"- References: {', '.join('`' + r + '`' for r in t['references'])}")
        md.append(
            f"- Accessed by {t['access_count']} function(s): "
            + ", ".join(f"`{a['name']}`" for a in t["accessed_by"][:10])
        )
    if rep["migrations"]:
        md.append("\n## Migrations\n" + "\n".join(f"- `{m}`" for m in rep["migrations"]))
    facts = "\n".join(md)
    narrative = await _narrate(
        "Database",
        facts,
        "Write a short 'Data model overview' explaining the main entities and their relationships in plain language.",
        max_tokens=900,
    )
    if narrative:
        return facts + "\n\n## Data model overview (AI)\n\n" + narrative, True
    return facts, False


async def gen_dependencies(ctx: AnalysisContext) -> tuple[str, bool]:
    rep = dependency.build_report(ctx)
    md = [
        f"# {ctx.repo.name} — Dependencies\n",
        f"{rep['total']} declared across {', '.join(rep['ecosystems'])}; {rep['dev_count']} dev-only.\n",
    ]
    md.append(
        _md_table(
            ["Package", "Ecosystem", "Version", "Dev", "Importing files"],
            [
                [r["name"], r["ecosystem"], r["version"], "yes" if r["dev"] else "", r["importers"]]
                for r in rep["inventory"]
            ],
        )
    )
    if rep["unused"]:
        md.append(
            "\n## Declared but never imported\n"
            + "\n".join(f"- `{r['name']}` ({r['ecosystem']})" for r in rep["unused"])
        )
    if rep["undeclared"]:
        md.append(
            "\n## Imported but not declared\n"
            + "\n".join(f"- `{r['module']}` ← {', '.join(r['files'][:3])}" for r in rep["undeclared"])
        )
    if rep["risky"]:
        md.append("\n## Risky\n" + "\n".join(f"- `{r['name']}` — {r['reason']}" for r in rep["risky"]))
    facts = "\n".join(md)
    narrative = await _narrate(
        "Dependencies",
        facts,
        "Explain in one paragraph each what the 5-8 most important runtime dependencies are used for in this codebase, based on which files import them.",
        max_tokens=1200,
    )
    if narrative:
        return facts + "\n\n## What the key dependencies do (AI)\n\n" + narrative, True
    return facts, False


async def gen_setup(ctx: AnalysisContext) -> tuple[str, bool]:
    stack = ctx.repo.stack or {}
    files = {f.path for f in ctx.rg.by_kind(NodeKind.FILE)}
    root_manifests = [n.meta.get("manifests", []) for n in ctx.rg.by_kind(NodeKind.DIRECTORY)]
    md = [f"# {ctx.repo.name} — Setup guide\n", "## Prerequisites\n"]
    for lang in stack.get("languages", []):
        md.append(f"- {lang['name']}")
    md.append("\n## Install & run (inferred)\n")
    pm = set(stack.get("package_managers", []))
    if (
        "pip" in pm
        or any("pyproject.toml" in m or "requirements.txt" in m for m in root_manifests)
        or stack.get("primary_language") == "Python"
    ):
        md.append(
            "```bash\npython -m venv .venv && source .venv/bin/activate\npip install -r requirements.txt   # or: pip install -e .\n```"
        )
    if pm & {"npm", "pnpm", "yarn", "bun"} or any("package.json" in m for m in root_manifests):
        tool = next((p for p in ("pnpm", "yarn", "bun", "npm") if p in pm), "npm")
        md.append(f"```bash\n{tool} install\n{tool} run dev\n```")
    if "go modules" in pm:
        md.append("```bash\ngo mod download\ngo run ./...\n```")
    if pm & {"Maven", "Gradle"}:
        md.append("```bash\n" + ("mvn package" if "Maven" in pm else "./gradlew build") + "\n```")
    if "Docker Compose" in stack.get("infra", []):
        md.append("```bash\ndocker compose up -d\n```")
    env_files = sorted(p for p in files if p.endswith((".env.example", ".env.sample", ".env.template")))
    if env_files:
        md.append("\n## Environment\nCopy " + ", ".join(f"`{e}`" for e in env_files) + " and fill in the values.")
    md.append("\n## Entry points\n" + "\n".join(f"- `{p}`" for p in heuristic_report(ctx.repo, ctx.rg)["entry_points"]))
    facts = "\n".join(md)
    narrative = await _narrate(
        "Setup guide",
        facts,
        "Rewrite as a friendly step-by-step setup guide, keeping only commands that are justified by the facts.",
        max_tokens=900,
    )
    return (narrative or facts), bool(narrative)


async def gen_onboarding(ctx: AnalysisContext) -> tuple[str, bool]:
    rep = heuristic_report(ctx.repo, ctx.rg)
    m = rep["metrics"]
    md = [f"# {ctx.repo.name} — Developer onboarding\n", "## Where to start\n"]
    md += [
        f"1. Read the architecture doc; the system has {len(rep['components'])} components: "
        + ", ".join(f"`{c['name']}`" for c in rep["components"][:8])
    ]
    md += ["2. Entry points: " + ", ".join(f"`{p}`" for p in rep["entry_points"][:5])]
    md += ["3. Central files (most imported): " + ", ".join(f"`{x['path']}`" for x in m["most_imported"][:5])]
    md += [
        f"4. The API has {m['endpoints']} endpoints and the data model has {m['tables']} tables (see API and Database docs)."
    ]
    md += ["\n## Conventions observed\n"]
    stack = ctx.repo.stack or {}
    for k in ("testing", "tooling", "ci"):
        if stack.get(k):
            md.append(f"- {k.title()}: {', '.join(stack[k])}")
    facts = "\n".join(md)
    narrative = await _narrate(
        "Onboarding",
        facts,
        "Write a welcoming onboarding page: what the system does, a 'first week' reading order of files, and 3 good first tasks a new engineer could pick up (inferred from structure).",
        max_tokens=1200,
    )
    return (narrative or facts), bool(narrative)


async def generate(session: AsyncSession, repo: Repository, ctx: AnalysisContext, kinds: list[str]) -> list[Document]:
    docs: list[Document] = []
    for kind in kinds:
        if kind == "modules":
            for subject, title, content, ai in await gen_modules(ctx):
                docs.append(Document(repo_id=repo.id, kind=kind, title=title, subject=subject, content=content, ai=ai))
            continue
        fn = {
            "architecture": gen_architecture,
            "api": gen_api,
            "dataflow": gen_dataflow,
            "database": gen_database,
            "dependencies": gen_dependencies,
            "setup": gen_setup,
            "onboarding": gen_onboarding,
        }.get(kind)
        if fn is None:
            continue
        content, ai = await fn(ctx)
        docs.append(Document(repo_id=repo.id, kind=kind, title=f"{kind.title()}", subject="", content=content, ai=ai))
    for kind in kinds:
        await session.execute(delete(Document).where(Document.repo_id == repo.id, Document.kind == kind))
    session.add_all(docs)
    await session.commit()
    return docs


async def list_documents(session: AsyncSession, repo_id: str) -> list[Document]:
    return list(
        (
            await session.execute(
                select(Document).where(Document.repo_id == repo_id).order_by(Document.kind, Document.subject)
            )
        ).scalars()
    )
