"""Fallback chain over several providers/models (decisions.md D-018).

Free tiers fail in ordinary ways: rate limits, "high demand" 503s, retired model names, and calls that
hang for a minute or more. The chain tries each configured provider in order with a per-call timeout
and returns the first answer. Which link answered is recorded so the API can report it.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import re
import time
from dataclasses import dataclass, field

from archon.llm.base import LLMError, LLMProvider, Message

log = logging.getLogger("archon.llm")
_RETRY_IN = re.compile(r"(?:try again|retry) in\s+(\d+(?:\.\d+)?)\s*(ms|s|m)\b", re.IGNORECASE)

# The link that produced the most recent answer in this request/task (for UI attribution).
last_answered_by: contextvars.ContextVar[str] = contextvars.ContextVar("archon_llm_last", default="")


@dataclass(slots=True)
class LinkStats:
    ok: int = 0
    failed: int = 0
    last_error: str = ""
    last_latency_s: float = 0.0
    cooldown_until: float = 0.0


@dataclass(slots=True)
class FallbackChain(LLMProvider):
    links: list[LLMProvider]
    timeout_s: float = 90.0
    cooldown_s: float = 60.0
    stats: dict[str, LinkStats] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.links:
            raise LLMError("no LLM providers configured")
        for p in self.links:
            self.stats.setdefault(self.label(p), LinkStats())

    @staticmethod
    def label(p: LLMProvider) -> str:
        return f"{p.name}:{p.model}"

    @property
    def name(self) -> str:  # type: ignore[override]
        return self.links[0].name

    @property
    def model(self) -> str:  # type: ignore[override]
        return self.links[0].model

    async def complete(
        self,
        messages: list[Message],
        *,
        system: str = "",
        temperature: float = 0.2,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str:
        errors: list[str] = []
        now = time.monotonic()
        # Links that just failed are tried last rather than skipped, so a single-link chain still works.
        ordered = sorted(self.links, key=lambda p: self.stats[self.label(p)].cooldown_until > now)
        for p in ordered:
            lab = self.label(p)
            st = self.stats[lab]
            t0 = time.perf_counter()
            try:
                text = await asyncio.wait_for(
                    p.complete(
                        messages, system=system, temperature=temperature, max_tokens=max_tokens, json_mode=json_mode
                    ),
                    timeout=self.timeout_s,
                )
            except Exception as e:  # noqa: BLE001 - every failure is a reason to try the next link
                reason = "timeout" if isinstance(e, TimeoutError) else f"{type(e).__name__}: {str(e)[:200]}"
                st.last_error = reason
                if type(e).__name__ == "PromptTooLarge":
                    # Not a health problem: this request is just too big for the link. No cooldown.
                    errors.append(f"{lab} → skipped (prompt too large)")
                    continue
                st.failed += 1
                st.cooldown_until = time.monotonic() + self._cooldown_for(e)
                errors.append(f"{lab} → {reason}")
                log.warning("LLM link %s failed (%s); trying next", lab, reason)
                continue
            st.ok += 1
            st.last_latency_s = round(time.perf_counter() - t0, 2)
            st.cooldown_until = 0.0
            last_answered_by.set(lab)
            return text
        raise LLMError("all LLM providers failed: " + " | ".join(errors))

    def _cooldown_for(self, e: BaseException) -> float:
        """Honour the provider's "try again in Ns" hint on rate limits; otherwise the default cooldown."""
        m = _RETRY_IN.search(str(e))
        if m:
            value, unit = float(m.group(1)), m.group(2)
            secs = value / 1000 if unit == "ms" else value * 60 if unit == "m" else value
            return min(max(secs, 1.0), self.cooldown_s * 5)
        return self.cooldown_s

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise LLMError("the completion chain does not embed; use archon.llm.embed()")

    def status(self) -> list[dict[str, object]]:
        now = time.monotonic()
        out: list[dict[str, object]] = []
        for p in self.links:
            lab = self.label(p)
            st = self.stats[lab]
            row: dict[str, object] = {
                "link": lab,
                "ok": st.ok,
                "failed": st.failed,
                "last_error": st.last_error,
                "last_latency_s": st.last_latency_s,
                "cooling_down": st.cooldown_until > now,
            }
            for attr in ("tpm_limit", "otpm_limit", "recovered_json"):
                if getattr(p, attr, 0):
                    row[attr] = getattr(p, attr)
            out.append(row)
        return out
