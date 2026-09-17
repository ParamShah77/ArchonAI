"""Google Gemini provider (free tier via AI Studio)."""

from __future__ import annotations

from google import genai
from google.genai import types
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential_jitter

from archon.llm.base import LLMError, LLMProvider, Message


def _retryable(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(k in msg for k in ("429", "resource_exhausted", "503", "unavailable", "deadline", "overloaded"))


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(self, api_key: str, model: str, embed_model: str) -> None:
        if not api_key:
            raise LLMError("GEMINI_API_KEY is not set")
        self.client = genai.Client(api_key=api_key)
        self.model = model
        self.embed_model = embed_model

    @retry(
        retry=retry_if_exception(_retryable),
        stop=stop_after_attempt(4),
        wait=wait_exponential_jitter(2, 30),
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
        contents = [
            types.Content(role="user" if m.role == "user" else "model", parts=[types.Part(text=m.content)])
            for m in messages
        ]
        cfg = types.GenerateContentConfig(
            system_instruction=system or None,
            temperature=temperature,
            max_output_tokens=max_tokens,
            response_mime_type="application/json" if json_mode else None,
        )
        resp = await self.client.aio.models.generate_content(model=self.model, contents=contents, config=cfg)
        text = resp.text
        if not text:
            raise LLMError("Gemini returned an empty response")
        return text

    @retry(
        retry=retry_if_exception(_retryable),
        stop=stop_after_attempt(4),
        wait=wait_exponential_jitter(2, 30),
        reraise=True,
    )
    async def embed(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), 100):  # API batch limit
            resp = await self.client.aio.models.embed_content(
                model=self.embed_model,
                contents=texts[i : i + 100],
                config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT", output_dimensionality=768),
            )
            out.extend([list(e.values or []) for e in (resp.embeddings or [])])
        return out
