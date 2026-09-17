"""Capability 14 — dependency intelligence (report + findings)."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from archon.analysis.base import NODE_BUILTINS, AnalysisContext, Analyzer, stdlib_modules
from archon.analysis.findings import Finding, Severity
from archon.graph.model import EdgeKind, NodeKind

# Libraries with well-known problems. (name -> reason, severity)
RISKY: dict[str, tuple[str, Severity]] = {
    "request": ("Deprecated since 2020; no security fixes.", Severity.MEDIUM),
    "moment": ("In maintenance mode; large bundle. Prefer date-fns/dayjs/Temporal.", Severity.LOW),
    "node-uuid": ("Deprecated; use uuid.", Severity.LOW),
    "lodash": ("Large surface; prefer per-method imports or native APIs.", Severity.INFO),
    "pycrypto": ("Unmaintained; known vulnerabilities. Use cryptography/pycryptodome.", Severity.HIGH),
    "md5": ("MD5 is cryptographically broken.", Severity.MEDIUM),
    "flask-script": ("Deprecated; use Flask CLI.", Severity.LOW),
    "nose": ("Unmaintained test runner; use pytest.", Severity.LOW),
    "django-rest-swagger": ("Unmaintained; use drf-spectacular.", Severity.LOW),
    "tslint": ("Deprecated in favour of ESLint.", Severity.LOW),
    "core-js@2": ("Old core-js line.", Severity.LOW),
    "left-pad": ("Trivial dependency; inline it.", Severity.INFO),
    "colors": ("Supply-chain incident history (2022).", Severity.MEDIUM),
    "faker": ("npm 'faker' was sabotaged in 2022; use @faker-js/faker.", Severity.MEDIUM),
    "event-stream": ("Supply-chain incident history (2018).", Severity.MEDIUM),
    "xmldom": ("Deprecated; use @xmldom/xmldom.", Severity.LOW),
    "github.com/dgrijalva/jwt-go": ("Unmaintained; CVE-2020-26160. Use github.com/golang-jwt/jwt.", Severity.HIGH),
    "log4j:log4j": ("Log4j 1.x is end-of-life with known CVEs.", Severity.HIGH),
    "org.apache.logging.log4j:log4j-core": ("Ensure >= 2.17.1 (Log4Shell).", Severity.MEDIUM),
    "commons-collections:commons-collections": ("Deserialization gadget chains (< 3.2.2).", Severity.MEDIUM),
}
_TOOLING_NAMES = re.compile(
    r"(?i)^(eslint|prettier|typescript|@types/|tailwind|postcss|autoprefixer|vite|webpack|babel|@babel|jest|vitest|mocha|ts-node|tsx|nodemon|husky|lint-staged|ruff|black|mypy|pytest|flake8|isort|coverage|pre-commit|tox|uvicorn|gunicorn|alembic|@tailwindcss|@testing-library|@playwright|cypress|storybook|@storybook|turbo|nx|lerna|rimraf|cross-env|dotenv-cli|concurrently|@next/|sharp|@vercel)"
)


def _unpinned(version: str, ecosystem: str) -> bool:
    v = (version or "").strip()
    if ecosystem == "pypi":
        return v == "" or not re.search(r"==|~=|>=.*<|<", v)
    if ecosystem == "npm":
        return v in ("", "*", "latest") or v.startswith((">", "x"))
    return v == ""


class DependencyAnalyzer(Analyzer):
    name = "dependency"
    description = "Unused, undeclared, risky and unpinned dependencies; coupling concentration."

    async def run(self, ctx: AnalysisContext) -> list[Finding]:
        report = build_report(ctx)
        out: list[Finding] = []
        for d in report["unused"]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="unused",
                    severity=Severity.LOW,
                    title=f"Declared but never imported: {d['name']}",
                    description="No source file imports this package (tooling/CLI packages are excluded by heuristic).",
                    path=d["manifest"],
                    evidence=f"{d['ecosystem']}:{d['name']} {d['version']}",
                    recommendation="Remove it from the manifest, or add the import if it is used indirectly (e.g. plugins) and document why.",
                    confidence=0.45 if d["dev"] else 0.6,
                    tags=[d["ecosystem"]],
                )
            )
        for p in report["undeclared"]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="undeclared",
                    severity=Severity.MEDIUM,
                    title=f"Imported but not declared: {p['module']}",
                    description="The module is imported but no manifest declares it; builds depend on the environment.",
                    path=p["files"][0],
                    evidence=f"imported in {len(p['files'])} file(s): {', '.join(p['files'][:4])}",
                    recommendation="Declare the package (with a version) in the manifest.",
                    confidence=0.55,
                    tags=[p["ecosystem"]],
                )
            )
        for d in report["risky"]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="risky",
                    severity=d["severity"],
                    title=f"Risky dependency: {d['name']}",
                    description=d["reason"],
                    path=d["manifest"],
                    evidence=f"{d['ecosystem']}:{d['name']} {d['version']}",
                    recommendation="Replace or upgrade as described.",
                    confidence=0.8,
                    tags=[d["ecosystem"]],
                )
            )
        for d in report["unpinned"][:40]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="unpinned",
                    severity=Severity.LOW,
                    title=f"Unpinned dependency: {d['name']}",
                    description="Without an upper bound, a new major release can break the build without any code change.",
                    path=d["manifest"],
                    evidence=f"{d['ecosystem']}:{d['name']} '{d['version']}'",
                    recommendation="Pin to a compatible range and use a lock file.",
                    confidence=0.6,
                    tags=[d["ecosystem"]],
                )
            )
        for d in report["hubs"][:10]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="concentration",
                    severity=Severity.INFO,
                    title=f"{d['name']} is imported by {d['importers']} files",
                    description="A widely used third-party API is expensive to replace; isolate it behind an adapter if it is not foundational.",
                    path=d["manifest"],
                    evidence=f"{d['importers']} importing files",
                    recommendation="Consider an internal wrapper module for non-framework libraries.",
                    confidence=0.5,
                    tags=[d["ecosystem"]],
                )
            )
        return out


def build_report(ctx: AnalysisContext) -> dict[str, Any]:
    rg = ctx.rg
    deps = rg.by_kind(NodeKind.DEPENDENCY)
    importers: dict[str, set[str]] = defaultdict(set)
    for e in rg.edges:
        if e.kind == EdgeKind.IMPORTS and e.target in rg.nodes and rg.nodes[e.target].kind == NodeKind.DEPENDENCY:
            importers[e.target].add(rg.nodes[e.source].path)
    inventory = []
    unused, risky, unpinned, hubs = [], [], [], []
    for d in sorted(deps, key=lambda n: (n.meta.get("ecosystem", ""), n.name.lower())):
        eco = d.meta.get("ecosystem", "")
        row = {
            "name": d.name,
            "ecosystem": eco,
            "version": d.meta.get("version", ""),
            "dev": bool(d.meta.get("dev")),
            "manifest": d.meta.get("manifest", ""),
            "importers": len(importers.get(d.id, ())),
            "files": sorted(importers.get(d.id, ()))[:20],
            "node_id": d.id,
        }
        inventory.append(row)
        if row["importers"] == 0 and not _TOOLING_NAMES.search(d.name) and eco in ("pypi", "npm", "go"):
            unused.append(row)
        key = d.name if eco != "npm" or not d.name.startswith("@") else d.name
        hit = RISKY.get(key) or RISKY.get(d.name.lower())
        if hit:
            risky.append({**row, "reason": hit[0], "severity": hit[1]})
        if _unpinned(row["version"], eco) and not row["dev"]:
            unpinned.append(row)
        if row["importers"] >= 8:
            hubs.append(row)
    # undeclared: external-looking imports with no dependency node
    declared_py = {d.name.lower().replace("_", "-") for d in deps if d.meta.get("ecosystem") == "pypi"}
    declared_npm = {d.name for d in deps if d.meta.get("ecosystem") == "npm"}
    local_py_roots = {
        f.meta.get("module", "").split(".")[0] for f in rg.by_kind(NodeKind.FILE) if f.language == "python"
    }
    undeclared: dict[tuple[str, str], set[str]] = defaultdict(set)
    for f in rg.by_kind(NodeKind.FILE):
        text = ctx.read(f.path) or ""
        if f.language == "python":
            for m in re.finditer(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))", text, re.MULTILINE):
                mod = (m.group(1) or m.group(2)).split(".")[0]
                if not mod or mod in stdlib_modules() or mod in local_py_roots or mod.replace("_", "-") in declared_py:
                    continue
                if any(
                    f2.path.startswith(mod + "/") or f2.path.endswith(f"/{mod}.py") or f2.path == f"{mod}.py"
                    for f2 in rg.by_kind(NodeKind.FILE)
                ):
                    continue
                undeclared[("pypi", mod)].add(f.path)
        elif f.language in ("javascript", "typescript", "tsx"):
            for m in re.finditer(r"(?:from\s+|require\(\s*|import\(\s*)[\"']([^\"'./][^\"']*)[\"']", text):
                spec = m.group(1)
                if spec.startswith("node:"):
                    continue
                name = "/".join(spec.split("/")[:2]) if spec.startswith("@") else spec.split("/")[0]
                if name in NODE_BUILTINS or name in declared_npm or spec.startswith(("@/", "~/")):
                    continue
                if not declared_npm:
                    continue  # no package.json parsed at all: cannot judge
                undeclared[("npm", name)].add(f.path)
    undeclared_rows = [
        {"ecosystem": e, "module": mname, "files": sorted(fs)} for (e, mname), fs in sorted(undeclared.items())
    ]
    return {
        "total": len(inventory),
        "ecosystems": sorted({r["ecosystem"] for r in inventory}),
        "inventory": inventory,
        "unused": unused,
        "undeclared": undeclared_rows,
        "risky": risky,
        "unpinned": unpinned,
        "hubs": sorted(hubs, key=lambda r: -r["importers"]),
        "dev_count": len([r for r in inventory if r["dev"]]),
    }
