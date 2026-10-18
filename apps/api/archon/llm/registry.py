"""Provider selection by settings + convenience functions (decisions.md D-004, D-018)."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from functools import lru_cache
from typing import Any

from archon.config import get_settings
from archon.llm.base import LLMError, LLMProvider, Message, extract_json
from archon.llm.chain import FallbackChain

log = logging.getLogger("archon.llm")


def _build(name: str, model: str | None = None) -> LLMProvider:
    s = get_settings()
    name = name.strip().lower()
    if name == "gemini":
        from archon.llm.gemini import GeminiProvider

        return GeminiProvider(s.gemini_api_key, model or s.gemini_model, s.gemini_embed_model, s.gemini_thinking_level)
    if name == "mock":
        from archon.llm.mock import MockProvider

        return MockProvider()
    if name in ("groq", "xai"):
        from archon.llm.openai_compat import OpenAICompatProvider

        key = s.groq_api_key if name == "groq" else s.xai_api_key
        default_model = s.groq_model if name == "groq" else s.xai_model
        tpm = s.groq_tpm_limit if name == "groq" else 0
        return OpenAICompatProvider(name, key, model or default_model, tpm_limit=tpm)
    raise LLMError(f"unknown LLM provider: {name}")


@lru_cache
def get_provider(name: str | None = None) -> LLMProvider:
    """A single provider (used for embeddings and diagnostics). Features should use the chain."""
    return _build(name or get_settings().archon_llm_provider)


def chain_specs() -> list[tuple[str, str | None]]:
    """`ARCHON_LLM_PROVIDER` first, then `ARCHON_LLM_FALLBACKS` ("provider" or "provider:model", comma-separated)."""
    s = get_settings()
    specs: list[tuple[str, str | None]] = [(s.archon_llm_provider, None)]
    for item in s.archon_llm_fallbacks.split(","):
        item = item.strip()
        if not item:
            continue
        prov, _, model = item.partition(":")
        specs.append((prov.strip(), model.strip() or None))
    seen: set[tuple[str, str | None]] = set()
    return [x for x in specs if not (x in seen or seen.add(x))]


@lru_cache
def get_chain() -> FallbackChain:
    s = get_settings()
    links: list[LLMProvider] = []
    for prov, model in chain_specs():
        try:
            links.append(_build(prov, model))
        except LLMError as e:  # missing key: leave this link out, keep the others
            log.info("LLM link %s:%s skipped (%s)", prov, model or "default", e)
    if not links:
        raise LLMError("No LLM provider configured (set GEMINI_API_KEY, GROQ_API_KEY or XAI_API_KEY).")
    return FallbackChain(links, timeout_s=s.archon_llm_timeout)


def reset() -> None:
    """Drop cached providers (tests and settings changes)."""
    get_provider.cache_clear()
    get_chain.cache_clear()


def llm_available() -> bool:
    try:
        get_chain()
        return True
    except LLMError:
        return False


def llm_status() -> list[dict[str, object]]:
    try:
        return get_chain().status()
    except LLMError:
        return []


def embed_available() -> bool:
    s = get_settings()
    if s.archon_embed_provider == "mock" or s.archon_llm_provider == "mock":
        return True
    return s.archon_embed_provider == "gemini" and bool(s.gemini_api_key)


async def complete(
    prompt: str,
    *,
    system: str = "",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    history: list[Message] | None = None,
) -> str:
    messages = [*(history or []), Message("user", prompt)]
    return await get_chain().complete(messages, system=system, temperature=temperature, max_tokens=max_tokens)


def stream(
    prompt: str,
    *,
    system: str = "",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    history: list[Message] | None = None,
) -> AsyncIterator[str]:
    """Like complete(), but yields the answer in pieces as it is written."""
    messages = [*(history or []), Message("user", prompt)]
    return get_chain().stream(messages, system=system, temperature=temperature, max_tokens=max_tokens)


async def complete_json(prompt: str, *, system: str = "", temperature: float = 0.1, max_tokens: int = 4096) -> Any:
    chain = get_chain()
    text = await chain.complete(
        [Message("user", prompt)], system=system, temperature=temperature, max_tokens=max_tokens, json_mode=True
    )
    try:
        return extract_json(text)
    except LLMError:
        # one repair attempt
        fixed = await chain.complete(
            [Message("user", f"Convert the following into strictly valid JSON, no prose:\n\n{text}")],
            system="You output only valid JSON.",
            temperature=0,
            max_tokens=max_tokens,
            json_mode=True,
        )
        return extract_json(fixed)


async def embed(texts: list[str]) -> list[list[float]]:
    s = get_settings()
    if s.archon_embed_provider == "mock" or s.archon_llm_provider == "mock":
        return await get_provider("mock").embed(texts)
    if s.archon_embed_provider == "gemini":
        return await get_provider("gemini").embed(texts)
    raise LLMError(f"embedding provider not available: {s.archon_embed_provider}")
