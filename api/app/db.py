"""Engine and session handling."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

from fastapi import Request
from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker


def create_db_engine(url: str) -> Engine:
    """One engine per app. Postgres is the real target; SQLite exists for tests and quick local runs."""
    if url.startswith("sqlite"):
        engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 30})

        @event.listens_for(engine, "connect")
        def _sqlite_pragmas(dbapi_connection: Any, _record: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

        return engine
    # pre_ping drops connections a restarted database has killed, instead of failing the next request.
    # A database that is unreachable must fail fast, so /readyz and the degraded mode can react, not hang.
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=10, connect_args={"connect_timeout": 5})


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(engine, expire_on_commit=False)


def get_session(request: Request) -> Iterator[Session]:
    """FastAPI dependency: one session per request, always closed."""
    factory: sessionmaker[Session] = request.app.state.session_factory
    with factory() as session:
        yield session
