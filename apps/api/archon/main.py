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
from archon.llm import embed_available, llm_available, llm_status

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
    if settings.archon_api_key:
        from starlette.requests import Request
        from starlette.responses import JSONResponse

        @app.middleware("http")
        async def require_api_key(request: Request, call_next):  # type: ignore[no-untyped-def]
            open_paths = ("/health", "/docs", "/openapi.json", "/redoc")
            if request.method == "OPTIONS" or request.url.path.startswith(open_paths):
                return await call_next(request)
            if request.headers.get("x-api-key") != settings.archon_api_key:
                return JSONResponse({"detail": "invalid or missing X-API-Key"}, status_code=401)
            return await call_next(request)

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
            llm_chain=llm_status(),
            embeddings=embed_available(),
            database=get_engine().dialect.name,
        )

    return app


app = create_app()

if __name__ == "__main__":
    import uvicorn

    s = get_settings()
    uvicorn.run("archon.main:app", host=s.archon_api_host, port=s.archon_api_port, reload=True)
