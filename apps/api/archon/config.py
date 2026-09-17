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

    # LLM
    archon_llm_provider: str = "gemini"
    archon_embed_provider: str = "gemini"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    gemini_embed_model: str = "gemini-embedding-001"
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"
    xai_api_key: str = ""
    xai_model: str = "grok-3-mini"

    # Storage
    database_url: str = "sqlite+aiosqlite:///./data/archon.db"
    archon_workspace: str = "./workspace"

    # API
    archon_api_key: str = ""  # when set, every request (except /health and the OpenAPI docs) needs X-API-Key
    archon_api_host: str = "127.0.0.1"
    archon_api_port: int = 8000
    archon_cors_origins: str = "http://localhost:3000"

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
