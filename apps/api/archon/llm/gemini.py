"""Google Gemini provider (free tier via AI Studio).

Gemini 3.x models "think" before answering, and thinking tokens count against `max_output_tokens`.
A small cap therefore yields `finish_reason=MAX_TOKENS` with no text (decisions.md D-018). We add
headroom for thinking and request a low thinking level, falling back to no thinking config for
models that reject it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential_jitter

from archon.llm.base import LLMError, LLMProvider, Message

THINKING_HEADROOM = 2048  # extra output budget reserved for reasoning tokens


def _transient(exc: BaseException) -> bool:
    """Retry only rate limits and server overload; a fallback provider handles everything else."""
    if isinstance(exc, genai_errors.ServerError):
        return True
    if isinstance(exc, genai_errors.ClientError):
        return getattr(exc, "code", None) == 429
    return False


def _server_error(exc: BaseException) -> bool:
    return isinstance(exc, genai_errors.ServerError)


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(self, api_key: str, model: str, embed_model: str, thinking_level: str = "low") -> None:
        if not api_key:
            raise LLMError("GEMINI_API_KEY is not set")
        self.client = genai.Client(api_key=api_key)
        self.model = model
        self.embed_model = embed_model
        self.thinking_level = thinking_level.strip().lower()
        self._thinking_supported = bool(self.thinking_level) and self.thinking_level != "off"

    def _config(self, system: str, temperature: float, max_tokens: int, json_mode: bool) -> types.GenerateContentConfig:
        kwargs = {}
        if self._thinking_supported:
            kwargs["thinking_config"] = types.ThinkingConfig(thinking_level=self.thinking_level)
        return types.GenerateContentConfig(
            system_instruction=system or None,
            temperature=temperature,
            max_output_tokens=max_tokens + THINKING_HEADROOM,
            response_mime_type="application/json" if json_mode else None,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            **kwargs,
        )

    @retry(
        retry=retry_if_exception(_transient),
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
        contents = [
            types.Content(role="user" if m.role == "user" else "model", parts=[types.Part(text=m.content)])
            for m in messages
        ]
        try:
            resp = await self.client.aio.models.generate_content(
                model=self.model, contents=contents, config=self._config(system, temperature, max_tokens, json_mode)
            )
        except genai_errors.ClientError as e:
            # Older/other models reject thinking_level: remember that and retry once without it.
            if self._thinking_supported and getattr(e, "code", None) == 400 and "thinking" in str(e).lower():
                self._thinking_supported = False
                resp = await self.client.aio.models.generate_content(
                    model=self.model, contents=contents, config=self._config(system, temperature, max_tokens, json_mode)
                )
            else:
                raise
        text = resp.text
        if not text:
            finish = resp.candidates[0].finish_reason if resp.candidates else None
            raise LLMError(f"Gemini {self.model} returned no text (finish_reason={finish})")
        return text

    async def stream(
        self, messages: list[Message], *, system: str = "", temperature: float = 0.2, max_tokens: int = 4096
    ) -> AsyncIterator[str]:
        contents = [
            types.Content(role="user" if m.role == "user" else "model", parts=[types.Part(text=m.content)])
            for m in messages
        ]

        async def start() -> AsyncIterator[types.GenerateContentResponse]:
            return await self.client.aio.models.generate_content_stream(
                model=self.model, contents=contents, config=self._config(system, temperature, max_tokens, False)
            )

        try:
            it = await start()
        except genai_errors.ClientError as e:
            # Older/other models reject thinking_level: remember that and retry once without it.
            if self._thinking_supported and getattr(e, "code", None) == 400 and "thinking" in str(e).lower():
                self._thinking_supported = False
                it = await start()
            else:
                raise
        async for chunk in it:
            if chunk.text:
                yield chunk.text

    @retry(
        retry=retry_if_exception(_server_error),
        stop=stop_after_attempt(3),
        wait=wait_exponential_jitter(1, 8),
        reraise=True,
    )
    async def _embed_batch(self, batch: list[str]) -> list[list[float]]:
        resp = await self.client.aio.models.embed_content(
            model=self.embed_model,
            contents=batch,
            config=types.EmbedContentConfig(task_type="RETRIEVAL_DOCUMENT", output_dimensionality=768),
        )
        return [list(e.values or []) for e in (resp.embeddings or [])]

    async def embed(self, texts: list[str]) -> list[list[float]]:
        # Retry per batch so one rate-limited batch does not redo the whole repository.
        out: list[list[float]] = []
        for i in range(0, len(texts), 100):  # API batch limit
            out.extend(await self._embed_batch(texts[i : i + 100]))
        return out
