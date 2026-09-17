"""Capability 9 — technical debt detection."""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict

from archon.analysis.base import AnalysisContext, Analyzer
from archon.analysis.codeshape import analyze_body
from archon.analysis.findings import Finding, Severity
from archon.graph.model import EdgeKind, NodeKind

LONG_FUNCTION = 80
VERY_LONG_FUNCTION = 200
MAX_PARAMS = 6
GOD_CLASS_METHODS = 20
DEEP_NESTING = 5
HIGH_CYCLOMATIC = 15
LARGE_FILE = 800
HIGH_FAN_OUT = 15
DUP_WINDOW = 6
_ENTRY_NAMES = {"main", "__init__", "__main__", "setup", "app", "handler", "lambda_handler", "default", "render"}
_NOISE = re.compile(r"\s+|#.*$|//.*$")


class DebtAnalyzer(Analyzer):
    name = "debt"
    description = "Long/complex functions, god classes, duplication, dead code, coupling, cycles, TODOs."

    async def run(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        out += self._function_rules(ctx)
        out += self._class_rules(ctx)
        out += self._file_rules(ctx)
        out += self._dead_code(ctx)
        out += self._duplication(ctx)
        out += self._cycles(ctx)
        return out

    def _function_rules(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        for fn in ctx.callables():
            if ctx.is_test_path(fn.path):
                continue
            src = ctx.source_of(fn, max_lines=1000)
            if not src:
                continue
            sh = analyze_body(fn, src)
            name = fn.qualified_name.split("::")[-1]
            base = dict(
                analyzer=self.name,
                path=fn.path,
                node_id=fn.id,
                start_line=fn.start_line,
                end_line=fn.end_line,
                tags=[fn.language],
            )
            if sh.code_lines >= VERY_LONG_FUNCTION:
                out.append(
                    Finding(
                        category="complexity",
                        severity=Severity.HIGH,
                        title=f"Very long function {name} ({sh.code_lines} lines)",
                        description="Functions this size hide several responsibilities and are hard to test in isolation.",
                        evidence=f"{sh.code_lines} code lines, cyclomatic≈{sh.cyclomatic}",
                        recommendation="Extract cohesive blocks into named helpers; aim for < 50 lines.",
                        confidence=0.8,
                        **base,
                    )
                )
            elif sh.code_lines >= LONG_FUNCTION:
                out.append(
                    Finding(
                        category="complexity",
                        severity=Severity.MEDIUM,
                        title=f"Long function {name} ({sh.code_lines} lines)",
                        description="Long functions raise the cost of every change and review.",
                        evidence=f"{sh.code_lines} code lines, cyclomatic≈{sh.cyclomatic}",
                        recommendation="Split by responsibility; keep each helper at one level of abstraction.",
                        confidence=0.7,
                        **base,
                    )
                )
            if sh.cyclomatic >= HIGH_CYCLOMATIC:
                out.append(
                    Finding(
                        category="complexity",
                        severity=Severity.MEDIUM,
                        title=f"High cyclomatic complexity in {name} (≈{sh.cyclomatic})",
                        description="Many independent paths; each needs a test.",
                        evidence=f"{sh.branches} branches, {sh.loops} loops",
                        recommendation="Replace branch ladders with lookup tables, polymorphism, or early returns.",
                        confidence=0.6,
                        **base,
                    )
                )
            if sh.max_nesting >= DEEP_NESTING:
                out.append(
                    Finding(
                        category="complexity",
                        severity=Severity.LOW,
                        title=f"Deep nesting in {name} (depth {sh.max_nesting})",
                        description="Deep nesting is a readability and reasoning cost.",
                        evidence=f"max nesting = {sh.max_nesting}",
                        recommendation="Invert conditions with guard clauses; extract the inner block.",
                        confidence=0.6,
                        **base,
                    )
                )
            if sh.params > MAX_PARAMS:
                out.append(
                    Finding(
                        category="design",
                        severity=Severity.LOW,
                        title=f"{name} takes {sh.params} parameters",
                        description="Long parameter lists signal a missing object/config.",
                        evidence=str(fn.meta.get("params", ""))[:200],
                        recommendation="Group related parameters into a dataclass/options object.",
                        confidence=0.7,
                        **base,
                    )
                )
            for ln in sh.todos:
                out.append(
                    Finding(
                        category="todo",
                        severity=Severity.INFO,
                        title=f"TODO/FIXME in {name}",
                        path=fn.path,
                        node_id=fn.id,
                        start_line=ln,
                        end_line=ln,
                        evidence=ctx.lines(fn.path)[ln - 1].strip()[:200] if ln <= len(ctx.lines(fn.path)) else "",
                        recommendation="Track it in the issue tracker or resolve it.",
                        confidence=0.9,
                        analyzer=self.name,
                        tags=["todo"],
                    )
                )
        return out

    def _class_rules(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        for cls in ctx.rg.by_kind(NodeKind.CLASS):
            if ctx.is_test_path(cls.path):
                continue
            methods = [
                ctx.rg.nodes[t]
                for t, d in ctx.rg.out_edges(cls.id, EdgeKind.CONTAINS)
                if t in ctx.rg.nodes and ctx.rg.nodes[t].kind == NodeKind.METHOD
            ]
            if len(methods) >= GOD_CLASS_METHODS:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="design",
                        severity=Severity.MEDIUM,
                        title=f"God class {cls.name} ({len(methods)} methods)",
                        description="Classes with many methods accumulate unrelated responsibilities.",
                        path=cls.path,
                        start_line=cls.start_line,
                        end_line=cls.end_line,
                        node_id=cls.id,
                        evidence=", ".join(m.name for m in methods[:12]) + ("…" if len(methods) > 12 else ""),
                        recommendation="Split by responsibility (cohesive method groups → separate classes).",
                        confidence=0.65,
                        tags=[cls.language],
                    )
                )
        return out

    def _file_rules(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        for f in ctx.files():
            if ctx.is_test_path(f.path):
                continue
            n_lines = len(ctx.lines(f.path))
            fan_out = len(
                [1 for _, d in ctx.rg.out_edges(f.id, EdgeKind.IMPORTS) if not d.get("meta", {}).get("external")]
            )
            if n_lines >= LARGE_FILE:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="structure",
                        severity=Severity.MEDIUM,
                        title=f"Large file {f.path} ({n_lines} lines)",
                        description="Large modules are a coupling magnet and slow to navigate.",
                        path=f.path,
                        start_line=1,
                        end_line=n_lines,
                        node_id=f.id,
                        evidence=f"{n_lines} lines",
                        recommendation="Split into cohesive modules.",
                        confidence=0.7,
                        tags=[f.language],
                    )
                )
            if fan_out >= HIGH_FAN_OUT:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="coupling",
                        severity=Severity.MEDIUM,
                        title=f"{f.path} imports {fan_out} internal modules",
                        description="High efferent coupling: this file changes whenever any of its many dependencies change.",
                        path=f.path,
                        start_line=1,
                        end_line=1,
                        node_id=f.id,
                        evidence=f"internal fan-out = {fan_out}",
                        recommendation="Introduce a facade or move orchestration into smaller units.",
                        confidence=0.6,
                        tags=["graph"],
                    )
                )
        return out

    def _dead_code(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        for fn in ctx.callables():
            if ctx.is_test_path(fn.path) or fn.kind == NodeKind.METHOD:
                continue
            if (
                fn.name.startswith("_")
                and not fn.name.startswith("__")
                or fn.name in _ENTRY_NAMES
                or fn.name.startswith("test")
            ):
                pass
            if (
                fn.name in _ENTRY_NAMES
                or fn.name.startswith("test")
                or fn.meta.get("exported")
                or fn.meta.get("decorators")
                or fn.meta.get("annotations")
            ):
                continue
            if fn.name.isupper():
                continue  # Next.js route handlers, constants-as-functions
            incoming = [d["kind"] for _, d in ctx.rg.in_edges(fn.id) if d["kind"] in ("calls", "exposes")]
            outgoing_exposes = [1 for _, d in ctx.rg.out_edges(fn.id) if d["kind"] == "exposes"]
            if incoming or outgoing_exposes:
                continue
            # referenced by name anywhere else in the repo? (cheap textual check to reduce false positives)
            refs = 0
            pattern = re.compile(r"\b" + re.escape(fn.name) + r"\b")
            for f in ctx.files():
                text = ctx.read(f.path) or ""
                c = len(pattern.findall(text))
                refs += c - (1 if f.path == fn.path else 0)
                if refs > 0:
                    break
            if refs > 0:
                continue
            out.append(
                Finding(
                    analyzer=self.name,
                    category="dead-code",
                    severity=Severity.LOW,
                    title=f"Possibly unused function {fn.name}",
                    description="No calls, exports, decorators, or textual references were found anywhere in the repository.",
                    path=fn.path,
                    start_line=fn.start_line,
                    end_line=fn.end_line,
                    node_id=fn.id,
                    evidence="0 references outside its definition",
                    recommendation="Delete it, or add a test/usage if it is meant to be public API.",
                    confidence=0.5,
                    tags=["graph", fn.language],
                )
            )
        return out

    def _duplication(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        index: dict[str, list[tuple[str, int]]] = defaultdict(list)
        for f in ctx.files():
            if ctx.is_test_path(f.path):
                continue
            lines = [_NOISE.sub("", ln) for ln in ctx.lines(f.path)]
            lines = [ln for ln in lines if len(ln) > 3 and ln not in ("}", "{", ")", "]", "),", "});", "end")]
            if len(lines) < DUP_WINDOW * 2:
                continue
            seen_here: set[str] = set()
            for i in range(0, len(lines) - DUP_WINDOW + 1):
                key = hashlib.sha1("\n".join(lines[i : i + DUP_WINDOW]).encode()).hexdigest()
                if key in seen_here:
                    continue
                seen_here.add(key)
                index[key].append((f.path, i + 1))
        pairs: dict[tuple[str, str], int] = defaultdict(int)
        for locs in index.values():
            if len(locs) < 2:
                continue
            for a in range(len(locs)):
                for b in range(a + 1, len(locs)):
                    pa, pb = sorted((locs[a][0], locs[b][0]))
                    if pa != pb:
                        pairs[(pa, pb)] += 1
        for (pa, pb), windows in sorted(pairs.items(), key=lambda x: -x[1])[:30]:
            if windows < 2:
                continue
            approx = windows + DUP_WINDOW - 1
            out.append(
                Finding(
                    analyzer=self.name,
                    category="duplication",
                    severity=Severity.MEDIUM if approx >= 20 else Severity.LOW,
                    title=f"Duplicated code between {pa.split('/')[-1]} and {pb.split('/')[-1]} (~{approx} lines)",
                    description="Near-identical line sequences appear in both files; fixes must be applied twice.",
                    path=pa,
                    evidence=f"{pa} ↔ {pb}: {windows} matching {DUP_WINDOW}-line windows",
                    recommendation="Extract the shared logic into one function/module.",
                    confidence=0.55,
                    tags=["duplication"],
                )
            )
        return out

    def _cycles(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        for cyc in ctx.rg.metrics()["import_cycles"][:20]:
            out.append(
                Finding(
                    analyzer=self.name,
                    category="architecture",
                    severity=Severity.MEDIUM,
                    title=f"Import cycle ({len(cyc)} files)",
                    description="Cyclic imports couple modules bidirectionally and cause load-order bugs.",
                    path=cyc[0],
                    evidence=" → ".join(cyc) + f" → {cyc[0]}",
                    recommendation="Move the shared piece into a lower-level module that both import, or invert one dependency.",
                    confidence=0.85,
                    tags=["graph"],
                )
            )
        return out
