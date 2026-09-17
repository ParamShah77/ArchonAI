"""Repository ingestion pipeline (flow.md §3.1)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select

from archon.analysis.base import AnalysisContext
from archon.context.index import index_repository
from archon.db.models import Repository
from archon.db.session import session_factory
from archon.graph.builder import BuiltGraph, build_repo_graph
from archon.graph.model import FileExtraction
from archon.graph.query import graph_cache
from archon.graph.store import save_graph
from archon.ingest.extractors import extract_file
from archon.ingest.manifests import Dependency, go_module_name, parse_manifest
from archon.ingest.parsing import PARSEABLE
from archon.ingest.scanner import walk_files
from archon.ingest.stack import detect_stack
from archon.ingest.workspace import Checkout, clone_or_locate

log = logging.getLogger("archon.ingest")


@dataclass(slots=True)
class AnalysisResult:
    graph: BuiltGraph
    deps: list[Dependency]
    stack: dict[str, Any]
    file_count: int
    line_count: int
    languages: dict[str, int]
    parse_errors: list[str]
    seconds: float


def analyze_checkout(root: Path, repo_name: str) -> AnalysisResult:
    """CPU-bound: scan, parse, extract, build. Run in a worker thread."""
    t0 = time.perf_counter()
    extractions: list[FileExtraction] = []
    deps: list[Dependency] = []
    manifest_paths: list[str] = []
    langs: Counter[str] = Counter()
    errors: list[str] = []
    files = lines = 0
    for sf in walk_files(root):
        if sf.language == "manifest":
            deps.extend(parse_manifest(sf.path, sf.rel))
            manifest_paths.append(sf.rel)
            continue
        try:
            source = sf.path.read_bytes()
        except OSError as e:
            errors.append(f"{sf.rel}: {e}")
            continue
        files += 1
        lines += source.count(b"\n") + 1
        langs[sf.language] += 1
        if sf.language not in PARSEABLE and sf.language not in ("sql", "prisma"):
            continue
        try:
            fx = extract_file(sf.rel, sf.language, source)
        except Exception as e:  # noqa: BLE001 - one bad file must not kill ingestion
            errors.append(f"{sf.rel}: {type(e).__name__}: {e}")
            continue
        if fx is not None:
            extractions.append(fx)
    graph = build_repo_graph(
        repo_name, extractions, deps, go_module=go_module_name(root), manifest_paths=manifest_paths
    )
    stack = detect_stack(root, langs, deps)
    return AnalysisResult(graph, deps, stack, files, lines, dict(langs), errors, time.perf_counter() - t0)


async def ingest_repository(repo_id: str) -> None:
    """Background task: clone/locate -> analyze -> persist. Updates the repo row's status."""
    Session = session_factory()
    async with Session() as session:
        repo = await session.get(Repository, repo_id)
        if repo is None:
            return
        repo.status = "ingesting"
        repo.error = ""
        await session.commit()
        source = repo.source

    try:
        checkout: Checkout = await asyncio.to_thread(clone_or_locate, source, repo_id)
        result = await asyncio.to_thread(analyze_checkout, checkout.root, checkout.name)
    except Exception as e:  # noqa: BLE001
        log.exception("ingestion failed for %s", repo_id)
        async with Session() as session:
            repo = await session.get(Repository, repo_id)
            if repo is not None:
                repo.status = "failed"
                repo.error = f"{type(e).__name__}: {e}"
                await session.commit()
        return

    async with Session() as session:
        await save_graph(session, repo_id, result.graph)
        repo = await session.get(Repository, repo_id)
        if repo is not None:
            repo.name = checkout.name
            repo.local_path = str(checkout.root)
            repo.default_branch = checkout.branch
            repo.commit_sha = checkout.commit
            repo.stack = result.stack
            repo.stats = {
                "files": result.file_count,
                "lines": result.line_count,
                "languages": result.languages,
                "parse_errors": result.parse_errors[:50],
                "analysis_seconds": round(result.seconds, 2),
                **result.graph.stats,
            }
            repo.status = "ready"
        await session.commit()
    graph_cache.invalidate(repo_id)
    # Build the retrieval index right away so chat/docs work without a separate step (embeddings best-effort).
    try:
        async with Session() as session:
            repo = await session.get(Repository, repo_id)
            if repo is not None:
                rg = await graph_cache.get(session, repo_id)
                await index_repository(session, AnalysisContext(repo, rg))
    except Exception:  # noqa: BLE001
        log.exception("retrieval indexing failed for %s (chat will still work after POST /index)", repo_id)
    log.info(
        "ingested %s: %s nodes, %s edges in %.1fs",
        repo_id,
        result.graph.stats.get("nodes"),
        result.graph.stats.get("edges"),
        result.seconds,
    )


async def list_repositories() -> list[Repository]:
    async with session_factory()() as session:
        return list((await session.execute(select(Repository).order_by(Repository.created_at.desc()))).scalars())
