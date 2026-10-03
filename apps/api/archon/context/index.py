"""Hybrid retrieval: BM25 (always available) fused with embeddings (when a provider is configured)."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from archon.analysis.base import AnalysisContext, tokenize
from archon.config import get_settings
from archon.context.chunker import build_chunks
from archon.db.models import CodeChunk
from archon.graph.model import NodeKind
from archon.graph.query import RepoGraph
from archon.llm import LLMError, embed, embed_available

log = logging.getLogger("archon.context")


@dataclass(slots=True)
class Hit:
    chunk: CodeChunk
    score: float
    why: str


class BM25Index:
    def __init__(self, chunks: list[CodeChunk], k1: float = 1.4, b: float = 0.75) -> None:
        self.chunks = chunks
        self.k1, self.b = k1, b
        self.tf: list[Counter[str]] = []
        self.df: Counter[str] = Counter()
        self.len: list[int] = []
        for c in chunks:
            toks = tokenize(c.text) + tokenize(c.name) * 3 + tokenize(c.path)
            tf = Counter(toks)
            self.tf.append(tf)
            self.len.append(len(toks))
            self.df.update(tf.keys())
        self.avg = (sum(self.len) / len(self.len)) if self.len else 1.0
        self.n = len(chunks)

    def search(self, query: str, k: int = 20) -> list[tuple[int, float]]:
        q = tokenize(query)
        if not q or not self.n:
            return []
        scores: list[float] = [0.0] * self.n
        for term in set(q):
            df = self.df.get(term)
            if not df:
                continue
            idf = math.log(1 + (self.n - df + 0.5) / (df + 0.5))
            for i, tf in enumerate(self.tf):
                f = tf.get(term)
                if not f:
                    continue
                denom = f + self.k1 * (1 - self.b + self.b * self.len[i] / self.avg)
                scores[i] += idf * (f * (self.k1 + 1)) / denom
        ranked = sorted(((i, s) for i, s in enumerate(scores) if s > 0), key=lambda x: -x[1])
        return ranked[:k]


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


class RetrievalCache:
    def __init__(self) -> None:
        self._idx: dict[str, tuple[list[CodeChunk], BM25Index]] = {}
        self._lock = asyncio.Lock()

    async def get(self, session: AsyncSession, repo_id: str) -> tuple[list[CodeChunk], BM25Index]:
        hit = self._idx.get(repo_id)
        if hit:
            return hit
        async with self._lock:
            hit = self._idx.get(repo_id)
            if hit is None:
                chunks = list((await session.execute(select(CodeChunk).where(CodeChunk.repo_id == repo_id))).scalars())
                hit = (chunks, BM25Index(chunks))
                self._idx[repo_id] = hit
            return hit

    def invalidate(self, repo_id: str) -> None:
        self._idx.pop(repo_id, None)


retrieval_cache = RetrievalCache()


_index_locks: dict[str, asyncio.Lock] = {}


def _text_key(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


async def index_repository(
    session: AsyncSession, ctx: AnalysisContext, with_embeddings: bool | None = None
) -> dict[str, Any]:
    """(Re)build chunks for a repo (decisions.md D-013, D-019).

    Chunks are written immediately so keyword retrieval works at once. Vectors of chunks whose text is
    unchanged are reused. Missing vectors are embedded inline when they fit one minute of the provider's
    quota, otherwise by a paced background job (`archon.context.embedder`).
    """
    from archon.context import embedder

    lock = _index_locks.setdefault(ctx.repo.id, asyncio.Lock())
    async with lock:
        previous = {
            _text_key(text): vec
            for text, vec in (
                await session.execute(
                    select(CodeChunk.text, CodeChunk.embedding).where(CodeChunk.repo_id == ctx.repo.id)
                )
            ).all()
            if vec
        }
        use_embed = embed_available() if with_embeddings is None else with_embeddings
        rows = []
        reused = 0
        for c in build_chunks(ctx):
            vec = previous.get(_text_key(c.text)) if use_embed else None
            reused += vec is not None
            rows.append(
                CodeChunk(
                    repo_id=ctx.repo.id,
                    node_id=c.node_id,
                    kind=c.kind,
                    name=c.name,
                    path=c.path,
                    start_line=c.start_line,
                    end_line=c.end_line,
                    text=c.text,
                    embedding=vec,
                )
            )
        await session.execute(delete(CodeChunk).where(CodeChunk.repo_id == ctx.repo.id))
        session.add_all(rows)
        await session.commit()
        retrieval_cache.invalidate(ctx.repo.id)

    missing = sum(1 for r in rows if r.embedding is None) if use_embed else 0
    embedded_now = 0
    background = False
    if missing and not embedder.is_running(ctx.repo.id):
        if missing <= get_settings().archon_embed_rpm:
            try:
                embedded_now = await embedder.embed_batch(ctx.repo.id, missing)
            except (LLMError, Exception) as e:  # noqa: BLE001 - retrieval still works via BM25
                log.warning("inline embedding failed, scheduling background job: %s", e)
                background = embedder.start(ctx.repo.id)
        else:
            background = embedder.start(ctx.repo.id)
    elif missing:
        background = True
    return {
        "chunks": len(rows),
        "embedded": reused + embedded_now,
        "reused": reused,
        "pending": max(0, missing - embedded_now),
        "background": background,
    }


async def retrieve(session: AsyncSession, rg: RepoGraph, repo_id: str, query: str, k: int = 10) -> list[Hit]:
    chunks, bm25 = await retrieval_cache.get(session, repo_id)
    if not chunks:
        return []
    fused: dict[int, float] = defaultdict(float)
    why: dict[int, str] = {}
    for rank, (i, _) in enumerate(bm25.search(query, k=k * 3)):
        fused[i] += 1.0 / (60 + rank)
        why[i] = "keyword"
    has_vectors = any(c.embedding for c in chunks)
    if has_vectors:
        try:
            qv = (await embed([query]))[0]
            sims = sorted(
                ((i, _cosine(qv, c.embedding)) for i, c in enumerate(chunks) if c.embedding),
                key=lambda x: -x[1],
            )[: k * 3]
            for rank, (i, _) in enumerate(sims):
                fused[i] += 1.0 / (60 + rank)
                why[i] = "semantic+keyword" if i in why else "semantic"
        except (LLMError, Exception) as e:  # noqa: BLE001
            log.warning("query embedding failed: %s", e)
    # graph boost: chunks whose node name appears verbatim in the query
    q_tokens = set(tokenize(query))
    for i, c in enumerate(chunks):
        if c.name and c.name.lower() in q_tokens:
            fused[i] += 0.05
            why[i] = (why.get(i, "") + "+name").lstrip("+")
    ranked = sorted(fused.items(), key=lambda x: -x[1])[:k]
    return [Hit(chunks[i], s, why[i]) for i, s in ranked]


def graph_facts(rg: RepoGraph, node_ids: list[str], limit: int = 8) -> list[str]:
    """Short natural-language facts about a node's relationships, for the prompt."""
    facts: list[str] = []
    for nid in node_ids[:limit]:
        n = rg.node(nid)
        if n is None or n.kind == NodeKind.FILE:
            continue
        callers = [rg.nodes[s].name for s, d in rg.in_edges(nid) if d["kind"] == "calls" and s in rg.nodes][:6]
        callees = [rg.nodes[t].name for t, d in rg.out_edges(nid) if d["kind"] == "calls" and t in rg.nodes][:6]
        exposes = [rg.nodes[t].name for t, d in rg.out_edges(nid) if d["kind"] == "exposes" and t in rg.nodes]
        queries = [rg.nodes[t].name for t, d in rg.out_edges(nid) if d["kind"] == "queries" and t in rg.nodes]
        parts = []
        if exposes:
            parts.append(f"exposes {', '.join(exposes)}")
        if callers:
            parts.append(f"called by {', '.join(callers)}")
        if callees:
            parts.append(f"calls {', '.join(callees)}")
        if queries:
            parts.append(f"queries table(s) {', '.join(queries)}")
        if parts:
            facts.append(f"{n.qualified_name.split('::')[-1]} ({n.path}): " + "; ".join(parts))
    return facts
