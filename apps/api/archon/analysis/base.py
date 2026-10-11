"""Analyzer contract + shared analysis context."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from functools import lru_cache
from pathlib import Path

from archon.analysis.findings import Finding
from archon.db.models import Repository
from archon.graph.model import Node, NodeKind
from archon.graph.paths import TEST_PATH_RE
from archon.graph.query import RepoGraph
from archon.ingest.scanner import read_text

_IDENT_SPLIT = re.compile(r"[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])")


def tokenize(text: str) -> list[str]:
    """Identifier-aware tokenizer used by retrieval and duplicate detection."""
    return [t.lower() for t in _IDENT_SPLIT.split(text) if len(t) > 1]


class AnalysisContext:
    """Everything an analyzer needs: the repo row, its graph, and lazily-read file contents."""

    def __init__(self, repo: Repository, rg: RepoGraph) -> None:
        self.repo = repo
        self.rg = rg
        self.root = Path(repo.local_path)
        self._cache: dict[str, str | None] = {}

    def read(self, rel_path: str) -> str | None:
        if rel_path not in self._cache:
            try:
                self._cache[rel_path] = read_text(self.root / rel_path)
            except OSError:
                self._cache[rel_path] = None
        return self._cache[rel_path]

    def lines(self, rel_path: str) -> list[str]:
        text = self.read(rel_path)
        return text.splitlines() if text else []

    def source_of(self, node: Node, max_lines: int = 400) -> str:
        if not node.path or node.start_line <= 0:
            return ""
        ls = self.lines(node.path)
        return "\n".join(ls[node.start_line - 1 : min(node.end_line, node.start_line - 1 + max_lines)])

    def files(self, languages: set[str] | None = None) -> list[Node]:
        return [f for f in self.rg.by_kind(NodeKind.FILE) if not languages or f.language in languages]

    def callables(self) -> list[Node]:
        return self.rg.by_kind(NodeKind.FUNCTION, NodeKind.METHOD)

    @staticmethod
    def is_test_path(path: str) -> bool:
        return bool(TEST_PATH_RE.search(path))

    @property
    def total_lines(self) -> int:
        return int(self.repo.stats.get("lines") or 0)


class Analyzer(ABC):
    name: str = ""
    description: str = ""

    @abstractmethod
    async def run(self, ctx: AnalysisContext) -> list[Finding]: ...


@lru_cache(maxsize=1)
def stdlib_modules() -> frozenset[str]:
    import sys

    return frozenset(sys.stdlib_module_names)


NODE_BUILTINS = frozenset(
    "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain "
    "events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl "
    "stream string_decoder timers tls trace_events tty url util v8 vm wasi worker_threads zlib test".split()
)
