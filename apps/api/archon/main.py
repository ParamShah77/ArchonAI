"""FastAPI application factory (flow.md §1, §2)."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from archon import __version__
from archon.api.routes import analysis, graph, intelligence, repos
from archon.api.schemas import HealthOut
from archon.config import get_settings
from archon.db.session import dispose_db, get_engine, init_db
from archon.llm import llm_available

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    yield
    await dispose_db()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="ARCHON API", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(repos.router)
    app.include_router(graph.router)
    app.include_router(analysis.router)
    app.include_router(intelligence.router)

    @app.get("/health", response_model=HealthOut, tags=["meta"])
    async def health() -> HealthOut:
        return HealthOut(
            status="ok",
            version=__version__,
            llm_provider=settings.archon_llm_provider,
            llm_configured=llm_available(),
            database=get_engine().dialect.name,
        )

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    s = get_settings()
    uvicorn.run("archon.main:app", host=s.archon_api_host, port=s.archon_api_port, reload=True)
