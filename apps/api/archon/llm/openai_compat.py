"""OpenAI-compatible providers: Groq and xAI (both offer free tiers)."""

from __future__ import annotations

from openai import APIStatusError, AsyncOpenAI, RateLimitError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from archon.llm.base import LLMError, LLMProvider, Message

BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "xai": "https://api.x.ai/v1",
}


class OpenAICompatProvider(LLMProvider):
    def __init__(self, name: str, api_key: str, model: str) -> None:
        if not api_key:
            raise LLMError(f"{name.upper()}_API_KEY is not set")
        self.name = name
        self.model = model
        self.client = AsyncOpenAI(api_key=api_key, base_url=BASE_URLS[name])

    @retry(
        retry=retry_if_exception_type((RateLimitError, APIStatusError)),
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
        msgs: list[dict[str, str]] = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs += [{"role": m.role, "content": m.content} for m in messages]
        kwargs = {"response_format": {"type": "json_object"}} if json_mode else {}
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=msgs,
            temperature=temperature,
            max_tokens=max_tokens,
            **kwargs,  # type: ignore[arg-type]
        )
        text = resp.choices[0].message.content if resp.choices else None
        if not text:
            raise LLMError(f"{self.name} returned an empty response")
        return text
