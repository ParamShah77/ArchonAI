"""Deterministic provider for tests and offline demos (ARCHON_LLM_PROVIDER=mock).

It never calls the network. JSON-mode requests get a minimal object that satisfies every prompt
in the codebase (all prompts tolerate missing keys); plain requests echo a short summary.
"""

from __future__ import annotations

import hashlib
import json

from archon.llm.base import LLMProvider, Message


class MockProvider(LLMProvider):
    name = "mock"
    model = "mock-1"

    async def complete(
        self,
        messages: list[Message],
        *,
        system: str = "",
        temperature: float = 0.2,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str:
        last = messages[-1].content if messages else ""
        if json_mode:
            return json.dumps(
                {
                    "summary": "Mock analysis of the provided context.",
                    "architecture_style": "mock",
                    "components": [],
                    "data_flow": [],
                    "external_systems": [],
                    "risks": [],
                    "hypotheses": [],
                    "root_cause": "mock root cause",
                    "fix": "mock fix",
                    "plan": [],
                    "steps": [],
                    "recommendations": [],
                    "affected": [],
                    "findings": [],
                    "tests": [],
                    "proposals": [],
                    "timeline": [],
                    "answer": "Mock answer.",
                    "sections": {},
                    "mock": True,
                }
            )
        digest = hashlib.sha1(last.encode("utf-8")).hexdigest()[:8]
        return f"[mock:{digest}] {last[:120].strip()}"

    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for t in texts:
            h = hashlib.sha256(t.encode("utf-8")).digest()
            out.append([((b / 255.0) * 2 - 1) for b in h[:32]])
        return out
