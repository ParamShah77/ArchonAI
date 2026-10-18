"""Application settings, loaded from environment / .env (see .env.example)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo root is three levels up from this file: apps/api/archon/config.py
ROOT_DIR = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(ROOT_DIR / ".env", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # LLM (decisions.md D-004, D-018). Completions go through a fallback chain:
    # ARCHON_LLM_PROVIDER first, then ARCHON_LLM_FALLBACKS ("provider" or "provider:model", comma-separated).
    # Links whose API key is missing are skipped.
    archon_llm_provider: str = "groq"
    archon_llm_fallbacks: str = "groq:qwen/qwen3.8-27b,gemini,gemini:gemini-3.5-flash-lite"
    archon_llm_timeout: float = 60.0  # seconds per attempt before moving to the next link
    archon_embed_provider: str = "gemini"
    archon_embed_rpm: int = 90  # texts embedded per minute (Gemini free tier: 100)
    archon_embed_tpm: int = 20000  # estimated tokens/min; the job lowers it by 25% on every 429 (D-019)
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    gemini_embed_model: str = "gemini-embedding-001"
    gemini_thinking_level: str = "low"  # low | medium | high | off
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    groq_tpm_limit: int = 8000  # free tier tokens/minute per model; prompts that cannot fit skip Groq
    xai_api_key: str = ""
    xai_model: str = "grok-3-mini"

    # Run the static analyzers right after every ingestion (health and findings without a visit to Audit)
    archon_auto_analyze: bool = True

    # Storage
    database_url: str = "sqlite+aiosqlite:///./data/archon.db"
    archon_workspace: str = "./workspace"

    # API
    archon_api_key: str = ""  # when set, every request (except /health and the OpenAPI docs) needs X-API-Key
    archon_api_host: str = "127.0.0.1"
    archon_api_port: int = 8001
    archon_cors_origins: str = "http://localhost:3001,http://127.0.0.1:3001"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.archon_cors_origins.split(",") if o.strip()]

    @property
    def workspace_dir(self) -> Path:
        p = Path(self.archon_workspace)
        return p if p.is_absolute() else (ROOT_DIR / p)

    @property
    def resolved_database_url(self) -> str:
        """Make relative SQLite paths relative to the repo root, not the CWD."""
        url = self.database_url
        prefix = "sqlite+aiosqlite:///./"
        if url.startswith(prefix):
            rel = url[len(prefix) :]
            abs_path = (ROOT_DIR / rel).resolve()
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            return f"sqlite+aiosqlite:///{abs_path.as_posix()}"
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
