from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any


class LLMError(RuntimeError):
    pass


@dataclass(slots=True)
class Message:
    role: str  # "user" | "assistant"
    content: str


_JSON_BLOCK = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def extract_json(text: str) -> Any:
    """Parse JSON from a model reply, tolerating code fences and leading prose."""
    text = text.strip()
    m = _JSON_BLOCK.search(text)
    if m:
        text = m.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = min((i for i in (text.find("{"), text.find("[")) if i >= 0), default=-1)
    if start >= 0:
        for end in range(len(text), start, -1):
            try:
                return json.loads(text[start:end])
            except json.JSONDecodeError:
                continue
    raise LLMError("model did not return valid JSON")


class LLMProvider(ABC):
    name: str = ""
    model: str = ""

    @abstractmethod
    async def complete(
        self,
        messages: list[Message],
        *,
        system: str = "",
        temperature: float = 0.2,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str: ...

    async def stream(
        self, messages: list[Message], *, system: str = "", temperature: float = 0.2, max_tokens: int = 4096
    ) -> AsyncIterator[str]:
        """Yield the answer in pieces as it is written (decisions.md D-034). Without native streaming the
        whole answer arrives as one piece."""
        yield await self.complete(messages, system=system, temperature=temperature, max_tokens=max_tokens)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        raise LLMError(f"provider {self.name} does not support embeddings")
