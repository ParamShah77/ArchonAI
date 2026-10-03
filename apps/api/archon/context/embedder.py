"""Rate-paced background embedding of retrieval chunks (decisions.md D-019).

The Gemini free tier allows ~100 embedded texts per minute (each item in a batch counts). A real
repository has hundreds to thousands of chunks, so embedding inline would block a request for many
minutes and then fail on quota. Instead:

1. `index_repository` writes chunks immediately (BM25 works at once) and reuses vectors of chunks whose
   text is unchanged since the last index.
2. Chunks still missing a vector are embedded here in paced batches, in the background, one job per repo.
   Retrieval uses whatever vectors exist at query time, so quality improves as the job progresses.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

from sqlalchemy import String, cast, func, or_, select, update

from archon.config import get_settings
from archon.db.models import CodeChunk
from archon.db.session import end_read, session_factory
from archon.llm import embed

log = logging.getLogger("archon.embed")
_RETRY_DELAY = re.compile(r"retry(?:Delay)?['\"]?\s*(?:in|:)\s*['\"]?(\d+(?:\.\d+)?)s", re.IGNORECASE)
_jobs: dict[str, asyncio.Task[None]] = {}
_progress: dict[str, dict[str, object]] = {}


def missing_vector():
    """Rows without a vector: SQL NULL, or the JSON text 'null' written by older versions."""
    return or_(CodeChunk.embedding.is_(None), cast(CodeChunk.embedding, String) == "null")


def is_running(repo_id: str) -> bool:
    t = _jobs.get(repo_id)
    return t is not None and not t.done()


def progress(repo_id: str) -> dict[str, object]:
    return {"running": is_running(repo_id), **_progress.get(repo_id, {})}


def start(repo_id: str) -> bool:
    """Start the background job for a repo unless one is already running. Returns True if started."""
    if is_running(repo_id):
        return False
    _jobs[repo_id] = asyncio.create_task(_run(repo_id), name=f"embed:{repo_id}")
    return True


async def pending_count(repo_id: str) -> int:
    async with session_factory()() as s:
        return int(
            (
                await s.execute(
                    select(func.count()).select_from(CodeChunk).where(CodeChunk.repo_id == repo_id, missing_vector())
                )
            ).scalar_one()
        )


EMBED_CHARS = 6000  # per-chunk cap sent to the provider
CHARS_PER_TOKEN = 3.4


def est_tokens(text: str) -> int:
    return int(min(len(text), EMBED_CHARS) / CHARS_PER_TOKEN) + 4


async def embed_batch(repo_id: str, limit: int, token_budget: int | None = None) -> tuple[int, int]:
    """Embed up to `limit` chunks lacking a vector, within `token_budget` estimated tokens.

    Returns (chunks embedded, estimated tokens sent). At least one chunk is always sent.
    """
    from archon.context.index import retrieval_cache

    async with session_factory()() as s:
        rows = list(
            (
                await s.execute(
                    select(CodeChunk.id, CodeChunk.text)
                    .where(CodeChunk.repo_id == repo_id, missing_vector())
                    .limit(limit)
                )
            ).all()
        )
        if not rows:
            return 0, 0
        picked, tokens = [], 0
        for cid, text in rows:
            t = est_tokens(text)
            if picked and token_budget is not None and tokens + t > token_budget:
                break
            picked.append((cid, text))
            tokens += t
        await end_read(s)
        vectors = await embed([text[:EMBED_CHARS] for _, text in picked])
        for (cid, _), vec in zip(picked, vectors, strict=False):
            await s.execute(update(CodeChunk).where(CodeChunk.id == cid).values(embedding=vec))
        await s.commit()
    retrieval_cache.invalidate(repo_id)
    return len(picked), tokens


def _retry_after(e: BaseException, default: float) -> float:
    m = _RETRY_DELAY.search(str(e))
    return float(m.group(1)) + 1.0 if m else default


async def _run(repo_id: str) -> None:
    cfg = get_settings()
    rpm = max(1, cfg.archon_embed_rpm)
    tpm = max(1000, cfg.archon_embed_tpm)
    batch = min(rpm, 100)
    # Half a minute's token budget per batch keeps a steady flow and never trips the per-minute cap.
    token_budget = tpm // 2
    done, failures = 0, 0
    total = await pending_count(repo_id)
    _progress[repo_id] = {
        "total": total,
        "embedded": 0,
        "last_error": "",
        "rate": {"texts_per_min": rpm, "tokens_per_min": tpm},
    }
    log.info("embedding %s chunks for %s at <= %s texts and <= %s tokens per minute", total, repo_id, rpm, tpm)
    while True:
        t0 = time.monotonic()
        try:
            n, tokens = await embed_batch(repo_id, batch, token_budget)
        except Exception as e:  # noqa: BLE001 - quota/network: wait and retry, give up after repeated failures
            failures += 1
            _progress[repo_id]["last_error"] = f"{type(e).__name__}: {str(e)[:200]}"
            if "429" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                # The free tier's real per-minute ceiling is not published: slow down 25% per refusal.
                rpm, tpm = max(10, int(rpm * 0.75)), max(2000, int(tpm * 0.75))
                batch, token_budget = min(rpm, 100), tpm // 2
                _progress[repo_id]["rate"] = {"texts_per_min": rpm, "tokens_per_min": tpm}
            if failures >= 5:
                log.warning("embedding for %s stopped after %s failures: %s", repo_id, failures, e)
                return
            await asyncio.sleep(_retry_after(e, 60.0))
            continue
        if n == 0:
            log.info("embedding for %s complete (%s chunks)", repo_id, done)
            return
        failures = 0
        done += n
        _progress[repo_id]["embedded"] = done
        _progress[repo_id]["last_error"] = ""
        # pace by whichever limit is tighter: texts per minute or tokens per minute
        wait = max(60.0 * n / rpm, 60.0 * tokens / tpm)
        await asyncio.sleep(max(0.0, wait - (time.monotonic() - t0)))


async def resume_all() -> list[str]:
    """On startup, restart embedding for every repo that still has chunks without vectors (D-019)."""
    from archon.llm import embed_available

    if not embed_available():
        return []
    async with session_factory()() as s:
        repo_ids = [r for (r,) in (await s.execute(select(CodeChunk.repo_id).where(missing_vector()).distinct())).all()]
    return [rid for rid in repo_ids if start(rid)]
