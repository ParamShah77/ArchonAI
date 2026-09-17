"""LLM access layer (decisions.md D-004). Features import only from here.

from archon.llm import complete, complete_json, embed, llm_available
"""

from __future__ import annotations

from archon.llm.base import LLMError, LLMProvider, Message
from archon.llm.registry import complete, complete_json, embed, embed_available, get_provider, llm_available

__all__ = [
    "LLMError",
    "LLMProvider",
    "Message",
    "complete",
    "complete_json",
    "embed",
    "embed_available",
    "get_provider",
    "llm_available",
]
