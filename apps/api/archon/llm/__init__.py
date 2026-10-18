"""LLM access layer (decisions.md D-004, D-018). Features import only from here.

from archon.llm import complete, complete_json, embed, llm_available
"""

from __future__ import annotations

from archon.llm.base import LLMError, LLMProvider, Message
from archon.llm.registry import (
    AI_NOT_CONFIGURED,
    AI_UNAVAILABLE,
    complete,
    complete_json,
    embed,
    embed_available,
    get_chain,
    get_provider,
    llm_available,
    llm_status,
    public_error,
    stream,
)

__all__ = [
    "AI_NOT_CONFIGURED",
    "AI_UNAVAILABLE",
    "LLMError",
    "LLMProvider",
    "Message",
    "complete",
    "complete_json",
    "embed",
    "embed_available",
    "get_chain",
    "get_provider",
    "llm_available",
    "llm_status",
    "public_error",
    "stream",
]
