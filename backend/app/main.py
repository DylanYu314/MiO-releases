import asyncio
import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response

from app.config import get_settings
from app.events import job_events, playlist_import_events, run_event_listener
from app.logging_config import configure_logging, log_context
from app.playlist_imports import fail_interrupted_imports
from app.rate_limit import RateLimitMiddleware
from app.routers.access import router as access_router
from app.routers.client_errors import purge_expired_on_startup
from app.routers.client_errors import router as client_errors_router
from app.routers.google import router as google_router
from app.routers.jobs import router as jobs_router
from app.routers.playlist_imports import router as playlist_imports_router
from app.routers.playlists import router as playlists_router
from app.routers.search import router as search_router
from app.routers.songs import router as songs_router
from app.routers.spotify import router as spotify_router

# Before anything logs: both this process and each Celery worker configure the
# same JSON handler (app/logging_config.py).
configure_logging()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Deliveries happen on this loop, so the brokers need a reference to it
    # before any job can publish.
    loop = asyncio.get_running_loop()
    brokers = (job_events, playlist_import_events)
    for broker in brokers:
        broker.bind_loop(loop)
    # Relays progress published by worker processes into this one (ADR-006).
    listener = asyncio.create_task(run_event_listener(brokers))
    logger.info("api started")
    # Work enqueued before a crash is redelivered by Celery, but anything a
    # worker was *running* is gone; fail those rather than leave them looking
    # alive. Redundant once retries land, kept as a safety net.
    fail_interrupted_imports()
    # The only table here that grows on its own, written by an ungated endpoint
    # and by every device once a day (#322).
    purge_expired_on_startup()
    try:
        yield
    finally:
        listener.cancel()


# ⚠️ Read once, here, rather than per-request: FastAPI decides at construction
# whether the documentation routes exist at all, so a later change to the setting
# cannot re-open them. Passing None is what removes the route — serving a 404
# from a handler would still advertise that the path is special (#765).
_docs = get_settings().api_docs_enabled

app = FastAPI(
    title="MiO",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if _docs else None,
    redoc_url="/redoc" if _docs else None,
    openapi_url="/openapi.json" if _docs else None,
)

# Inbound request limiting (#514). Added before the routers so it sees every
# request, and skipped entirely at 0 so a development run is unaffected —
# `EXEMPT_PATHS` still lets the container healthcheck through either way.
_rate_limit = get_settings().rate_limit_per_minute
if _rate_limit > 0:
    app.add_middleware(RateLimitMiddleware, limit=_rate_limit)


@app.middleware("http")
async def log_requests(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """One structured line per request, and a request id that every log line
    written while handling it inherits."""
    started = time.perf_counter()
    with log_context(request_id=uuid.uuid4().hex[:12]):
        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "request failed",
                extra={
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": round((time.perf_counter() - started) * 1000, 1),
                },
            )
            raise
        logger.info(
            "request",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000, 1),
            },
        )
        return response


app.include_router(jobs_router)
app.include_router(client_errors_router)
app.include_router(songs_router)
app.include_router(playlists_router)
app.include_router(spotify_router)
app.include_router(google_router)
app.include_router(playlist_imports_router)
app.include_router(search_router)
app.include_router(access_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "commit": get_settings().git_sha}
