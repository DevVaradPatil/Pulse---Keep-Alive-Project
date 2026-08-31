"""Pulse health endpoint - FastAPI + SQLAlchemy.

Copy into your app and include the router:

    from health import router as health_router
    app.include_router(health_router)

WHAT MAKES THIS COUNT AS ACTIVITY
`SELECT 1` is executed by the database over a real pooled connection. Two
things would quietly break that:

  1. Reporting on the *pool* instead of querying. `engine.pool.status()` can
     look healthy while every pooled connection has gone stale behind a
     provider that closed them, so the endpoint has to issue a statement.
  2. Connection pooling on a serverless platform. If your database provider
     counts activity per connection rather than per statement, the pool can
     answer from a connection opened days ago. Where that matters, use
     `NullPool` for this route's engine, or query a real table instead.

Async version below the sync one - use whichever matches your app.

Then in config/targets.json:
    "type": "http",
    "url": "https://<your-service>/api/health",
    "expectBodyContains": "\\"ok\\":true"
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Response
from fastapi.responses import JSONResponse
from sqlalchemy import text

# Your application's engine / session factory.
from .database import SessionLocal  # type: ignore[import-not-found]

router = APIRouter()

DB_NAME = "postgres"  # shown in the response body; purely descriptive


@router.get("/api/health")
def health(response: Response) -> JSONResponse:
    """Return 200 with {"ok": true, ...} only after the database answers."""
    started_at = time.perf_counter()

    try:
        with SessionLocal() as session:
            # The statement that actually reaches the database. For a provider
            # that only counts table reads, use something like:
            #   session.execute(text("SELECT id FROM heartbeat LIMIT 1"))
            session.execute(text("SELECT 1")).scalar_one()

        latency_ms = round((time.perf_counter() - started_at) * 1000)
        return JSONResponse(
            status_code=200,
            content={"ok": True, "db": DB_NAME, "latencyMs": latency_ms},
            headers={"cache-control": "no-store"},
        )
    except Exception as exc:  # noqa: BLE001 - the endpoint must report, not raise
        latency_ms = round((time.perf_counter() - started_at) * 1000)
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "db": DB_NAME,
                "latencyMs": latency_ms,
                "error": str(exc)[:300],
            },
            headers={"cache-control": "no-store"},
        )


# --- Async variant (SQLAlchemy 2.0 asyncio) ---------------------------------
#
# from sqlalchemy.ext.asyncio import AsyncSession
# from .database import AsyncSessionLocal
#
# @router.get("/api/health")
# async def health_async() -> JSONResponse:
#     started_at = time.perf_counter()
#     try:
#         async with AsyncSessionLocal() as session:  # type: AsyncSession
#             await session.execute(text("SELECT 1"))
#         latency_ms = round((time.perf_counter() - started_at) * 1000)
#         return JSONResponse(
#             status_code=200,
#             content={"ok": True, "db": DB_NAME, "latencyMs": latency_ms},
#             headers={"cache-control": "no-store"},
#         )
#     except Exception as exc:  # noqa: BLE001
#         latency_ms = round((time.perf_counter() - started_at) * 1000)
#         return JSONResponse(
#             status_code=500,
#             content={"ok": False, "db": DB_NAME, "latencyMs": latency_ms, "error": str(exc)[:300]},
#             headers={"cache-control": "no-store"},
#         )
