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


async def embed_batch(repo_id: str, limit: int) -> int:
    """Embed up to `limit` chunks that lack a vector. Returns how many were embedded."""
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
            return 0
        await end_read(s)
        vectors = await embed([text[:6000] for _, text in rows])
        for (cid, _), vec in zip(rows, vectors, strict=False):
            await s.execute(update(CodeChunk).where(CodeChunk.id == cid).values(embedding=vec))
        await s.commit()
    retrieval_cache.invalidate(repo_id)
    return len(rows)


def _retry_after(e: BaseException, default: float) -> float:
    m = _RETRY_DELAY.search(str(e))
    return float(m.group(1)) + 1.0 if m else default


async def _run(repo_id: str) -> None:
    rpm = max(1, get_settings().archon_embed_rpm)
    batch = min(rpm, 100)
    done, failures = 0, 0
    total = await pending_count(repo_id)
    _progress[repo_id] = {"total": total, "embedded": 0, "last_error": ""}
    log.info("embedding %s chunks for %s at <= %s/min", total, repo_id, rpm)
    while True:
        t0 = time.monotonic()
        try:
            n = await embed_batch(repo_id, batch)
        except Exception as e:  # noqa: BLE001 - quota/network: wait and retry, give up after repeated failures
            failures += 1
            _progress[repo_id]["last_error"] = f"{type(e).__name__}: {str(e)[:200]}"
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
        # pace: n items per (60 * n / rpm) seconds
        await asyncio.sleep(max(0.0, 60.0 * n / rpm - (time.monotonic() - t0)))
