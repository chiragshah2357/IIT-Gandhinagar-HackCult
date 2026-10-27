"""Application factory. `create_app()` builds an app from settings, so tests can build one per test."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import InterfaceError, OperationalError

from app import __version__
from app.config import Settings, get_settings
from app.db import create_db_engine, create_session_factory
from app.guards import BodySizeLimit, FixedWindowLimiter, configure_logging, request_context
from app.routes import router
from app.services.scenario import ScenarioCache

log = logging.getLogger("lifecity.app")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    engine = create_db_engine(settings.database_url)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        engine.dispose()

    app = FastAPI(
        title="LiFE City API",
        version=__version__,
        summary="Campus energy readings and Mission LiFE scenario simulation.",
        description=(
            "Everything the simulation returns is modelled. No meter data is used yet, and the carbon curve, tariff "
            "and campaign effects are placeholders. See /model and the repository's docs/data-and-sources.md."
        ),
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = create_session_factory(engine)
    app.state.scenario_cache = ScenarioCache(settings.cache_max_entries)
    app.state.limiter = FixedWindowLimiter(settings.rate_limit_per_minute)

    # Added innermost first: the request id and log wrap everything, then CORS, then the body limit.
    app.add_middleware(BodySizeLimit, max_bytes=settings.max_body_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        expose_headers=["X-Cache", "X-Request-ID"],
    )
    app.middleware("http")(request_context)

    @app.exception_handler(OperationalError)
    @app.exception_handler(InterfaceError)
    async def database_unavailable(_: Request, exc: Exception) -> JSONResponse:
        log.error("database unavailable: %s", exc.__class__.__name__)
        return JSONResponse(
            status_code=503,
            content={"detail": "database unavailable"},
            headers={"Retry-After": "5"},
        )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Report where and why, but not the offending value. Echoing it back is how a NaN in the input
        # crashed the default handler, and it keeps request data out of responses and logs.
        errors = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
        return JSONResponse(status_code=422, content={"detail": errors})

    app.include_router(router)
    return app
