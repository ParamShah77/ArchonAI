"""Capability 6 — performance intelligence."""

from __future__ import annotations

from archon.analysis.base import AnalysisContext, Analyzer
from archon.analysis.codeshape import analyze_body
from archon.analysis.findings import Finding, Severity


class PerformanceAnalyzer(Analyzer):
    name = "performance"
    description = "N+1 queries, I/O in loops, blocking calls in async code, unbounded queries, algorithmic hot spots."

    async def run(self, ctx: AnalysisContext) -> list[Finding]:
        out: list[Finding] = []
        for fn in ctx.callables():
            if ctx.is_test_path(fn.path):
                continue
            src = ctx.source_of(fn, max_lines=600)
            if not src:
                continue
            sh = analyze_body(fn, src)
            name = fn.qualified_name.split("::")[-1]
            base = dict(analyzer=self.name, path=fn.path, node_id=fn.id, tags=[fn.language])

            def add(  # noqa: B023 - `name`, `fn`, `base` are bound per iteration via defaults below
                category: str,
                sev: Severity,
                title: str,
                lines: list[int],
                rec: str,
                conf: float,
                desc: str,
                name: str = name,
                fn=fn,
                base: dict = base,
            ) -> None:
                if not lines:
                    return
                out.append(
                    Finding(
                        category=category,
                        severity=sev,
                        title=f"{title} in {name}",
                        description=desc,
                        start_line=lines[0],
                        end_line=lines[-1],
                        evidence=self._lines(ctx, fn.path, lines[:3]),
                        recommendation=rec,
                        confidence=conf,
                        **base,
                    )
                )

            add(
                "n-plus-one",
                Severity.HIGH,
                "Database/query call inside a loop",
                sh.queries_in_loop,
                "Batch the query (IN (...) / join / prefetch) and run it once outside the loop.",
                0.6,
                "A query-like call executes on every iteration; cost scales with the collection size (N+1 pattern).",
            )
            add(
                "io-in-loop",
                Severity.MEDIUM,
                "HTTP call inside a loop",
                sh.http_in_loop,
                "Issue requests concurrently (asyncio.gather / Promise.all) or use a bulk endpoint.",
                0.6,
                "Sequential network round-trips inside a loop multiply latency.",
            )
            add(
                "sequential-await",
                Severity.LOW,
                "Sequential await inside a loop",
                sh.awaits_in_loop,
                "If iterations are independent, collect the coroutines/promises and await them together.",
                0.45,
                "Each iteration awaits before starting the next; independent work could run concurrently.",
            )
            add(
                "blocking-in-async",
                Severity.HIGH,
                "Blocking sleep in async function",
                sh.sync_sleep_in_async,
                "Use asyncio.sleep / await-able timers so the event loop is not blocked.",
                0.85,
                "time.sleep blocks the whole event loop, stalling every other request.",
            )
            add(
                "blocking-in-async",
                Severity.MEDIUM,
                "Blocking I/O in async function",
                sh.sync_http_in_async,
                "Use an async client (httpx.AsyncClient, aiofiles) or run the call in a thread (asyncio.to_thread).",
                0.6,
                "Synchronous I/O inside `async def` blocks the event loop for its full duration.",
            )
            add(
                "string-building",
                Severity.LOW,
                "String concatenation in a loop",
                sh.str_concat_in_loop,
                "Accumulate parts in a list and join once (or use a builder).",
                0.5,
                "Repeated concatenation is quadratic in the number of iterations for immutable strings.",
            )
            add(
                "regex-in-loop",
                Severity.LOW,
                "Regex compiled inside a loop",
                sh.regex_compile_in_loop,
                "Compile the pattern once at module level.",
                0.7,
                "Pattern compilation is repeated on every iteration.",
            )
            add(
                "unbounded-query",
                Severity.MEDIUM,
                "SELECT * usage",
                sh.select_star,
                "Select only the needed columns; wide rows inflate I/O and break when the schema changes.",
                0.55,
                "SELECT * fetches every column regardless of need.",
            )
            add(
                "unbounded-query",
                Severity.MEDIUM,
                "SELECT without LIMIT or keyed WHERE",
                sh.unbounded_select,
                "Add pagination (LIMIT/OFFSET or keyset) or a selective WHERE clause.",
                0.4,
                "The query can return the entire table as data grows.",
            )
            if sh.max_loop_depth >= 3:
                out.append(
                    Finding(
                        category="algorithmic",
                        severity=Severity.MEDIUM,
                        title=f"Loops nested {sh.max_loop_depth} deep in {name}",
                        description="Triple-nested iteration is O(n³) in the worst case.",
                        start_line=fn.start_line,
                        end_line=fn.end_line,
                        evidence=f"max loop depth = {sh.max_loop_depth}",
                        recommendation="Index the inner collections (dict/set lookups) or restructure the algorithm.",
                        confidence=0.5,
                        **base,
                    )
                )
            elif sh.max_loop_depth == 2 and sh.code_lines > 25:
                out.append(
                    Finding(
                        category="algorithmic",
                        severity=Severity.LOW,
                        title=f"Nested loops in {name}",
                        description="Nested iteration is O(n·m); fine for small inputs, a hot spot for large ones.",
                        start_line=fn.start_line,
                        end_line=fn.end_line,
                        evidence=f"max loop depth = 2, {sh.code_lines} code lines",
                        recommendation="Check whether the inner loop can become a hash lookup.",
                        confidence=0.35,
                        **base,
                    )
                )
        # graph-level: hub functions that reach many tables (fan-out) = candidate transaction hot spots
        for fn in ctx.callables():
            tables = [t for t, d in ctx.rg.out_edges(fn.id) if d["kind"] == "queries"]
            if len(tables) >= 4:
                out.append(
                    Finding(
                        analyzer=self.name,
                        category="data-access",
                        severity=Severity.LOW,
                        title=f"{fn.name} touches {len(tables)} tables",
                        description="One function reading/writing many tables tends to become a long transaction and a coupling point.",
                        path=fn.path,
                        start_line=fn.start_line,
                        end_line=fn.end_line,
                        node_id=fn.id,
                        evidence=", ".join(ctx.rg.nodes[t].name for t in tables if t in ctx.rg.nodes),
                        recommendation="Split into repository/service functions per aggregate; keep transactions short.",
                        confidence=0.4,
                        tags=["graph"],
                    )
                )
        return out

    @staticmethod
    def _lines(ctx: AnalysisContext, path: str, nums: list[int]) -> str:
        ls = ctx.lines(path)
        return "\n".join(f"{n}: {ls[n - 1].strip()[:160]}" for n in nums if 0 < n <= len(ls))
