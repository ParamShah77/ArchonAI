from __future__ import annotations

import os
from pathlib import Path

import pytest

FIXTURE_REPO = Path(__file__).parent / "fixtures" / "sample_repo"


@pytest.fixture(scope="session", autouse=True)
def _test_env(tmp_path_factory: pytest.TempPathFactory):
    """Isolate DB + workspace per test session, and never touch a real LLM."""
    root = tmp_path_factory.mktemp("archon")
    os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{(root / 'test.db').as_posix()}"
    os.environ["ARCHON_WORKSPACE"] = str(root / "workspace")
    os.environ["GEMINI_API_KEY"] = ""
    os.environ["GROQ_API_KEY"] = ""
    os.environ["XAI_API_KEY"] = ""
    from archon.config import get_settings
    from archon.llm.registry import reset as reset_llm

    get_settings.cache_clear()
    reset_llm()
    yield


@pytest.fixture
def fixture_repo() -> Path:
    return FIXTURE_REPO
