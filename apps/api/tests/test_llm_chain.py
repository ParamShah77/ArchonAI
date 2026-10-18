"""Fallback chain behaviour (decisions.md D-018) with fake providers; no network."""

from __future__ import annotations

import asyncio

import pytest

from archon.llm.base import LLMError, LLMProvider, Message
from archon.llm.chain import FallbackChain, last_answered_by


class Fake(LLMProvider):
    def __init__(self, name: str, model: str, behaviour: str) -> None:
        self.name, self.model, self.behaviour, self.calls = name, model, behaviour, 0

    async def complete(self, messages, *, system="", temperature=0.2, max_tokens=4096, json_mode=False) -> str:
        self.calls += 1
        if self.behaviour == "fail":
            raise LLMError("boom")
        if self.behaviour == "hang":
            await asyncio.sleep(5)
        return f"answer from {self.name}"


MSG = [Message("user", "hi")]


async def test_first_healthy_link_answers():
    a, b = Fake("groq", "m1", "ok"), Fake("gemini", "m2", "ok")
    chain = FallbackChain([a, b])
    assert await chain.complete(MSG) == "answer from groq"
    assert (a.calls, b.calls) == (1, 0)
    assert last_answered_by.get() == "groq:m1"


async def test_falls_back_on_error_and_timeout_then_cools_down():
    a, b, c = Fake("groq", "m1", "fail"), Fake("gemini", "slow", "hang"), Fake("gemini", "lite", "ok")
    chain = FallbackChain([a, b, c], timeout_s=0.05)
    assert await chain.complete(MSG) == "answer from gemini"
    st = {s["link"]: s for s in chain.status()}
    assert st["groq:m1"]["failed"] == 1 and st["groq:m1"]["cooling_down"]
    assert st["gemini:slow"]["last_error"] == "timeout"
    assert st["gemini:lite"]["ok"] == 1
    # next call: the healthy link is tried first, the cooled-down ones are not called
    await chain.complete(MSG)
    assert (a.calls, b.calls, c.calls) == (1, 1, 2)


async def test_all_links_failing_raises_with_every_reason():
    chain = FallbackChain([Fake("groq", "m1", "fail"), Fake("gemini", "m2", "fail")])
    with pytest.raises(LLMError) as ei:
        await chain.complete(MSG)
    assert "groq:m1" in str(ei.value) and "gemini:m2" in str(ei.value)


def test_registry_skips_links_without_keys(monkeypatch):
    from archon.config import get_settings
    from archon.llm import registry

    monkeypatch.setenv("ARCHON_LLM_PROVIDER", "groq")
    monkeypatch.setenv("ARCHON_LLM_FALLBACKS", "gemini:gemini-3.5-flash-lite,xai")
    monkeypatch.setenv("GROQ_API_KEY", "")
    monkeypatch.setenv("XAI_API_KEY", "")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key-not-used")
    get_settings.cache_clear()
    registry.reset()
    try:
        assert registry.chain_specs() == [("groq", None), ("gemini", "gemini-3.5-flash-lite"), ("xai", None)]
        chain = registry.get_chain()
        assert [FallbackChain.label(p) for p in chain.links] == ["gemini:gemini-3.5-flash-lite"]
    finally:
        monkeypatch.setenv("GEMINI_API_KEY", "")
        get_settings.cache_clear()
        registry.reset()


async def test_prompt_too_large_skips_without_cooldown_and_rate_limit_hint_sets_cooldown():
    from archon.llm.openai_compat import PromptTooLarge

    class TooBig(Fake):
        async def complete(self, messages, **kw) -> str:
            self.calls += 1
            raise PromptTooLarge("prompt too large")

    class Limited(Fake):
        async def complete(self, messages, **kw) -> str:
            self.calls += 1
            raise LLMError("Rate limit reached ... Please try again in 7.5s. Need more tokens?")

    big, lim, ok = TooBig("groq", "a", "x"), Limited("groq", "b", "x"), Fake("gemini", "c", "ok")
    chain = FallbackChain([big, lim, ok], cooldown_s=60)
    assert await chain.complete(MSG) == "answer from gemini"
    st = {s["link"]: s for s in chain.status()}
    assert st["groq:a"]["failed"] == 0 and not st["groq:a"]["cooling_down"]
    assert st["groq:b"]["failed"] == 1 and st["groq:b"]["cooling_down"]
    assert 6.0 < chain._cooldown_for(LLMError("try again in 7.5s")) < 8.0
    assert chain._cooldown_for(LLMError("try again in 250ms")) == 1.0
    assert chain._cooldown_for(LLMError("boom")) == 60


def test_groq_budget_caps_completion_and_rejects_oversized_prompts():
    from archon.llm.openai_compat import OpenAICompatProvider, PromptTooLarge

    p = OpenAICompatProvider("groq", "k", "m", tpm_limit=8000)
    small = [Message("user", "x" * 3200)]  # ≈1000 tokens
    assert p._completion_budget(small, "", 2048) == 2048 + 1024
    medium = [Message("user", "x" * 16000)]  # ≈5000 tokens -> only ~2.5k left in the minute budget
    assert 1024 <= p._completion_budget(medium, "", 4096) < 4096
    with pytest.raises(PromptTooLarge):
        p._completion_budget([Message("user", "x" * 30000)], "", 2048)
    assert OpenAICompatProvider("xai", "k", "m")._completion_budget(medium, "", 4096) == 4096 + 1024


async def test_end_read_refuses_pending_changes():
    from archon.db.models import Conversation
    from archon.db.session import end_read, init_db, session_factory

    await init_db()
    async with session_factory()() as s:
        await end_read(s)  # nothing pending: fine
        s.add(Conversation(repo_id="nope", title="t"))
        with pytest.raises(RuntimeError):
            await end_read(s)
        await s.rollback()


def test_groq_learns_limits_and_recovers_rejected_json():
    import httpx
    from openai import BadRequestError

    from archon.llm.openai_compat import OpenAICompatProvider, _failed_generation

    p = OpenAICompatProvider("groq", "k", "m", tpm_limit=8000)
    p._learn_limit("Request too large for model `m` on output tokens per minute (OTPM): Limit 2000, Requested 5120")
    assert p.otpm_limit == 2000
    assert p._completion_budget([Message("user", "hi")], "", 4096) == 1800
    p._learn_limit("Rate limit reached ... (TPM): Limit 6000, Used 5000")  # not "too large": no change
    assert p.tpm_limit == 8000

    req = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    body = {"error": {"code": "json_validate_failed", "failed_generation": '{"summary": "x"} trailing'}}
    err = BadRequestError("Failed to generate JSON", response=httpx.Response(400, request=req), body=body)
    assert _failed_generation(err) == '{"summary": "x"} trailing'
    other = BadRequestError("bad", response=httpx.Response(400, request=req), body={"error": {"code": "x"}})
    assert _failed_generation(other) is None


async def test_stream_uses_the_first_link_that_starts_answering():
    a, b = Fake("groq", "m1", "fail"), Fake("gemini", "m2", "ok")
    chain = FallbackChain([a, b])
    pieces = [p async for p in chain.stream(MSG)]
    assert "".join(pieces) == "answer from gemini"
    assert last_answered_by.get() == "gemini:m2"


async def test_stream_raises_when_every_link_fails():
    chain = FallbackChain([Fake("groq", "m1", "fail")])
    with pytest.raises(LLMError):
        _ = [p async for p in chain.stream(MSG)]
