"""OpenAI-compatible providers: Groq and xAI (both offer free tiers)."""

from __future__ import annotations

import re

from openai import (
    APIConnectionError,
    APITimeoutError,
    AsyncOpenAI,
    BadRequestError,
    InternalServerError,
    RateLimitError,
)
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from archon.llm.base import LLMError, LLMProvider, Message

BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "xai": "https://api.x.ai/v1",
}
# Reasoning models (gpt-oss, qwen3) spend completion tokens on reasoning before the answer.
REASONING_HEADROOM = 1024
# Conservative chars-per-token for mixed code + prose (code tokenizes denser than English).
CHARS_PER_TOKEN = 3.2
MIN_COMPLETION = 1024
_LIMIT = re.compile(r"\((TPM|OTPM)\):\s*Limit\s+(\d+)", re.IGNORECASE)


class PromptTooLarge(LLMError):
    """The prompt cannot fit this link's per-minute token budget; the chain should move on immediately."""


def estimate_tokens(messages: list[Message], system: str) -> int:
    chars = len(system) + sum(len(m.content) + 8 for m in messages)
    return int(chars / CHARS_PER_TOKEN) + 16


def _failed_generation(e: BadRequestError) -> str | None:
    body = e.body if isinstance(e.body, dict) else {}
    err = body.get("error", body) if isinstance(body, dict) else {}
    if not isinstance(err, dict) or err.get("code") != "json_validate_failed":
        return None
    text = err.get("failed_generation")
    return text if isinstance(text, str) and text.strip() else None


class OpenAICompatProvider(LLMProvider):
    def __init__(self, name: str, api_key: str, model: str, tpm_limit: int = 0) -> None:
        if not api_key:
            raise LLMError(f"{name.upper()}_API_KEY is not set")
        self.name = name
        self.model = model
        # Groq free tier: 8k tokens/minute per model, counted as prompt + requested max_tokens (D-018).
        self.tpm_limit = tpm_limit
        self.otpm_limit = 0  # learned from "Request too large ... (OTPM): Limit N" errors
        self.recovered_json = 0  # JSON-mode rejections recovered from `failed_generation`
        self.client = AsyncOpenAI(api_key=api_key, base_url=BASE_URLS[name], max_retries=0)

    def _completion_budget(self, messages: list[Message], system: str, max_tokens: int) -> int:
        wanted = max_tokens + REASONING_HEADROOM
        if self.otpm_limit:
            wanted = min(wanted, int(self.otpm_limit * 0.9))
            if wanted < MIN_COMPLETION:
                raise PromptTooLarge(f"{self.name}:{self.model} output budget is only {self.otpm_limit} tokens/min")
        if not self.tpm_limit:
            return wanted
        prompt = estimate_tokens(messages, system)
        room = int(self.tpm_limit * 0.95) - prompt
        if room < MIN_COMPLETION:
            raise PromptTooLarge(
                f"prompt ≈{prompt} tokens does not fit {self.name}:{self.model} budget of {self.tpm_limit} tokens/min"
            )
        return min(wanted, room)

    def _learn_limit(self, message: str) -> None:
        """Groq reports per-minute caps only in errors; remember them so later requests are sized to fit."""
        m = _LIMIT.search(message)
        if not m or "request too large" not in message.lower():
            return
        kind, limit = m.group(1).upper(), int(m.group(2))
        if kind == "OTPM":
            self.otpm_limit = limit
        else:
            self.tpm_limit = limit

    # Only transient failures are retried here; 4xx such as model-not-found go straight to the fallback chain.
    # A 429 is not retried in place either: the chain moves to the next link and cools this one down.
    @retry(
        retry=retry_if_exception_type((InternalServerError, APIConnectionError, APITimeoutError)),
        stop=stop_after_attempt(2),
        wait=wait_exponential_jitter(1, 4),
        reraise=True,
    )
    async def complete(
        self,
        messages: list[Message],
        *,
        system: str = "",
        temperature: float = 0.2,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str:
        budget = self._completion_budget(messages, system, max_tokens)
        msgs: list[dict[str, str]] = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs += [{"role": m.role, "content": m.content} for m in messages]
        kwargs = {"response_format": {"type": "json_object"}} if json_mode else {}
        try:
            resp = await self.client.chat.completions.create(
                model=self.model,
                messages=msgs,
                temperature=temperature,
                max_tokens=budget,
                **kwargs,  # type: ignore[arg-type]
            )
        except RateLimitError as e:
            self._learn_limit(str(e))
            raise
        except BadRequestError as e:
            # Groq validates JSON mode server-side and rejects near-misses (trailing prose, a truncated tail).
            # The rejected text comes back as `failed_generation`; the caller's tolerant JSON parser and its
            # repair step usually recover it, which is far cheaper than a second full request.
            recovered = _failed_generation(e) if json_mode else None
            if recovered:
                self.recovered_json += 1
                return recovered
            raise
        choice = resp.choices[0] if resp.choices else None
        text = choice.message.content if choice else None
        if not text:
            raise LLMError(
                f"{self.name} {self.model} returned no text (finish_reason={getattr(choice, 'finish_reason', None)})"
            )
        return text


__all__ = ["OpenAICompatProvider", "PromptTooLarge", "RateLimitError", "estimate_tokens"]
