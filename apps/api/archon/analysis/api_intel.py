"""Capability 12 — API intelligence: inventory, auth, reachability to services and tables, findings."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

import networkx as nx

from archon.analysis.base import AnalysisContext, Analyzer
from archon.analysis.findings import Finding, Severity
from archon.graph.model import EdgeKind, NodeKind
from archon.graph.query import RepoGraph

_AUTH_HINT = re.compile(
    r"(?i)auth|login|jwt|token|current_user|permission|require_?role|protected|guard|session|api_?key|bearer|principal"
)
_VERB_IN_PATH = re.compile(
    r"/(get|set|create|update|delete|remove|fetch|list|add|do|make|run|execute)[A-Z_/-]", re.IGNORECASE
)
_VERSIONED = re.compile(r"/v\d+(/|$)")
_PARAM = re.compile(r"\{(\w+)\}|:(\w+)")


def _handler_of(rg: RepoGraph, ep_id: str):
    for s, d in rg.in_edges(ep_id):
        if d["kind"] == "exposes" and s in rg.nodes:
            return rg.nodes[s]
    return None


def _call_graph(rg: RepoGraph) -> nx.DiGraph:
    g = nx.DiGraph()
    for e in rg.edges:
        if e.kind in (EdgeKind.CALLS, EdgeKind.QUERIES):
            g.add_edge(e.source, e.target)
    return g


def build_report(ctx: AnalysisContext) -> dict[str, Any]:
    rg = ctx.rg
    cg = _call_graph(rg)
    endpoints = []
    resources: dict[str, list[str]] = defaultdict(list)
    for ep in sorted(rg.by_kind(NodeKind.ENDPOINT), key=lambda n: (n.meta.get("route", ""), n.meta.get("method", ""))):
        h = _handler_of(rg, ep.id)
        route = str(ep.meta.get("route", ""))
        method = str(ep.meta.get("method", ""))
        reach: set[str] = set()
        if h is not None and h.id in cg:
            reach = set(nx.single_source_shortest_path_length(cg, h.id, cutoff=6).keys()) - {h.id}
        tables = sorted({rg.nodes[n].name for n in reach if n in rg.nodes and rg.nodes[n].kind == NodeKind.TABLE})
        services = sorted(
            {
                rg.nodes[n].qualified_name.split("::")[-1]
                for n in reach
                if n in rg.nodes and rg.nodes[n].kind in (NodeKind.FUNCTION, NodeKind.METHOD)
            }
        )[:25]
        decos = " ".join((h.meta.get("decorators", []) if h else []) + (h.meta.get("annotations", []) if h else []))
        params = str(h.meta.get("params", "")) if h else ""
        body = ctx.source_of(h, max_lines=40) if h else ""
        auth = bool(_AUTH_HINT.search(decos + " " + params)) or bool(_AUTH_HINT.search(body[:1200]))
        path_params = [a or b for a, b in _PARAM.findall(route)]
        resource = (
            "/" + "/".join(p for p in route.strip("/").split("/")[:2] if not p.startswith(("{", ":"))) if route else "/"
        )
        row = {
            "id": ep.id,
            "method": method,
            "route": route,
            "path": ep.path,
            "line": ep.start_line,
            "handler": h.qualified_name.split("::")[-1] if h else ep.meta.get("handler", ""),
            "handler_id": h.id if h else "",
            "params": params,
            "path_params": path_params,
            "auth": auth,
            "reaches_tables": tables,
            "calls": services,
            "depth": len(reach),
            "language": ep.language,
            "resource": resource,
        }
        endpoints.append(row)
        resources[resource].append(ep.id)
    by_method: dict[str, int] = defaultdict(int)
    for e in endpoints:
        by_method[e["method"]] += 1
    return {
        "count": len(endpoints),
        "by_method": dict(by_method),
        "resources": {k: len(v) for k, v in sorted(resources.items())},
        "endpoints": endpoints,
        "auth_coverage": (sum(1 for e in endpoints if e["auth"]) / len(endpoints)) if endpoints else None,
        "versioned": any(_VERSIONED.search(e["route"]) for e in endpoints),
    }


class ApiAnalyzer(Analyzer):
    name = "api"
    description = "Endpoint inventory, auth coverage, duplicate/inconsistent routes, versioning."

    async def run(self, ctx: AnalysisContext) -> list[Finding]:
        rep = build_report(ctx)
        out: list[Finding] = []
        seen: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for e in rep["endpoints"]:
            seen[(e["method"], re.sub(r"\{\w+\}|:\w+", "{}", e["route"]))].append(e)
        for (m, r), eps in seen.items():
            if len(eps) > 1:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="routing",
                        severity=Severity.MEDIUM,
                        title=f"Duplicate route {m} {r}",
                        description="Two handlers claim the same method+route; the framework will pick one silently.",
                        path=eps[0]["path"],
                        start_line=eps[0]["line"],
                        end_line=eps[0]["line"],
                        node_id=eps[0]["id"],
                        evidence="; ".join(f"{e['path']}:{e['line']} {e['handler']}" for e in eps),
                        recommendation="Merge or rename one of the routes.",
                        confidence=0.75,
                        tags=["routing"],
                    )
                )
        for e in rep["endpoints"]:
            if _VERB_IN_PATH.search(e["route"]):
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="design",
                        severity=Severity.INFO,
                        title=f"Verb in route path: {e['method']} {e['route']}",
                        description="REST resources are nouns; the HTTP method carries the verb.",
                        path=e["path"],
                        start_line=e["line"],
                        end_line=e["line"],
                        node_id=e["id"],
                        evidence=e["route"],
                        recommendation="Rename to a resource path and use the appropriate HTTP method.",
                        confidence=0.5,
                        tags=["rest"],
                    )
                )
            if e["method"] in ("GET", "HEAD") and e["handler_id"]:
                h = ctx.rg.node(e["handler_id"])
                src = ctx.source_of(h, max_lines=80) if h else ""
                if re.search(
                    r"(?i)\b(INSERT|UPDATE|DELETE FROM|\.save\(|\.create\(|\.delete\(|\.update\(|commit\()", src
                ):
                    out.append(
                        Finding(
                            analyzer=self.name,
                            category="design",
                            severity=Severity.MEDIUM,
                            title=f"GET endpoint appears to mutate state: {e['route']}",
                            description="Safe methods must not change state; crawlers, prefetchers and retries will trigger it.",
                            path=e["path"],
                            start_line=e["line"],
                            end_line=e["line"],
                            node_id=e["id"],
                            evidence=e["handler"],
                            recommendation="Move the mutation to POST/PUT/DELETE.",
                            confidence=0.5,
                            tags=["rest"],
                        )
                    )
        if rep["count"] >= 8 and not rep["versioned"]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="design",
                    severity=Severity.LOW,
                    title="API is not versioned",
                    description=f"{rep['count']} endpoints without a version prefix; breaking changes will hit every client at once.",
                    evidence="no /v1/ style prefix found",
                    recommendation="Introduce a version prefix or header before external clients depend on the API.",
                    confidence=0.5,
                    tags=["versioning"],
                )
            )
        return out
