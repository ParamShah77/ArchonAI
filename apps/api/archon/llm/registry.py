"""Provider selection by settings + convenience functions."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from archon.config import get_settings
from archon.llm.base import LLMError, LLMProvider, Message, extract_json


@lru_cache
def get_provider(name: str | None = None) -> LLMProvider:
    s = get_settings()
    name = (name or s.archon_llm_provider).lower()
    if name == "gemini":
        from archon.llm.gemini import GeminiProvider

        return GeminiProvider(s.gemini_api_key, s.gemini_model, s.gemini_embed_model)
    if name in ("groq", "xai"):
        from archon.llm.openai_compat import OpenAICompatProvider

        key = s.groq_api_key if name == "groq" else s.xai_api_key
        model = s.groq_model if name == "groq" else s.xai_model
        return OpenAICompatProvider(name, key, model)
    raise LLMError(f"unknown LLM provider: {name}")


def llm_available() -> bool:
    try:
        get_provider()
        return True
    except LLMError:
        return False


def embed_available() -> bool:
    s = get_settings()
    return s.archon_embed_provider == "gemini" and bool(s.gemini_api_key)


async def complete(
    prompt: str,
    *,
    system: str = "",
    temperature: float = 0.2,
    max_tokens: int = 4096,
    history: list[Message] | None = None,
) -> str:
    provider = get_provider()
    messages = [*(history or []), Message("user", prompt)]
    return await provider.complete(messages, system=system, temperature=temperature, max_tokens=max_tokens)


async def complete_json(prompt: str, *, system: str = "", temperature: float = 0.1, max_tokens: int = 4096) -> Any:
    provider = get_provider()
    text = await provider.complete(
        [Message("user", prompt)], system=system, temperature=temperature, max_tokens=max_tokens, json_mode=True
    )
    try:
        return extract_json(text)
    except LLMError:
        # one repair attempt
        fixed = await provider.complete(
            [Message("user", f"Convert the following into strictly valid JSON, no prose:\n\n{text}")],
            system="You output only valid JSON.",
            temperature=0,
            max_tokens=max_tokens,
            json_mode=True,
        )
        return extract_json(fixed)


async def embed(texts: list[str]) -> list[list[float]]:
    s = get_settings()
    if s.archon_embed_provider == "gemini":
        return await get_provider("gemini").embed(texts)
    raise LLMError(f"embedding provider not available: {s.archon_embed_provider}")
