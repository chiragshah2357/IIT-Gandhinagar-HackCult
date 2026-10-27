"""Health, request ids, CORS, errors, the rate limiter and the migrations."""

from __future__ import annotations

from pathlib import Path

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from fastapi.testclient import TestClient
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from alembic import command
from app.config import Settings
from app.db import create_db_engine
from app.guards import FixedWindowLimiter
from app.main import create_app
from app.models import Base
from tests.conftest import alembic_config

UNREACHABLE = "postgresql+psycopg://nobody:nope@127.0.0.1:1/none"


def test_healthz_does_not_need_the_database(settings: Settings) -> None:
    with TestClient(create_app(settings.model_copy(update={"database_url": UNREACHABLE}))) as client:
        assert client.get("/healthz").json() == {"status": "ok"}


def test_readyz_follows_the_database(client: TestClient, settings: Settings) -> None:
    assert client.get("/readyz").json() == {"status": "ready"}
    with TestClient(create_app(settings.model_copy(update={"database_url": UNREACHABLE}))) as down:
        response = down.get("/readyz")
        assert response.status_code == 503 and response.json() == {"status": "database unavailable"}
        # Any route that needs the database answers with a clean 503 and a hint to retry, not a stack trace.
        outage = down.get("/campuses")
        assert outage.status_code == 503 and outage.headers["Retry-After"] == "5"
        assert outage.json() == {"detail": "database unavailable"}


def test_a_request_id_is_echoed_or_generated(client: TestClient) -> None:
    echoed = client.get("/healthz", headers={"X-Request-ID": "trace-abc-12345"})
    assert echoed.headers["X-Request-ID"] == "trace-abc-12345"
    generated = client.get("/healthz", headers={"X-Request-ID": "bad id with spaces"}).headers["X-Request-ID"]
    assert len(generated) == 32 and generated.isalnum()


def test_cors_allows_the_configured_origin_only(client: TestClient) -> None:
    preflight = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
    allowed = client.options("/scenarios/simulate", headers={"Origin": "http://localhost:5191", **preflight})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5191"
    other = client.options("/scenarios/simulate", headers={"Origin": "https://evil.example", **preflight})
    assert "access-control-allow-origin" not in other.headers


def test_unknown_routes_are_json_404s(client: TestClient) -> None:
    response = client.get("/nope")
    assert response.status_code == 404 and response.headers["content-type"].startswith("application/json")


def test_the_openapi_document_lists_every_route(client: TestClient) -> None:
    paths = set(client.get("/openapi.json").json()["paths"])
    assert {"/readings:batch", "/scenarios/simulate", "/healthz", "/readyz", "/campuses", "/model"} <= paths


# ---------------------------------------------------------------- the rate limiter on its own


def test_fixed_window_limiter() -> None:
    now = [0.0]
    limiter = FixedWindowLimiter(2, window_seconds=60, clock=lambda: now[0])
    assert limiter.check("a") is None and limiter.check("a") is None
    retry = limiter.check("a")
    assert retry is not None and 0 < retry <= 60
    assert limiter.check("b") is None  # another client has its own allowance
    now[0] = 61
    assert limiter.check("a") is None  # a new window


def test_a_limit_of_zero_switches_the_limiter_off() -> None:
    limiter = FixedWindowLimiter(0)
    assert all(limiter.check("a") is None for _ in range(1000))


# ---------------------------------------------------------------- migrations and constraints


def test_the_models_and_the_migrations_describe_the_same_schema(database_url: str) -> None:
    engine = create_db_engine(database_url)
    with engine.connect() as connection:
        context = MigrationContext.configure(connection, opts={"compare_type": True})
        assert compare_metadata(context, Base.metadata) == []
    engine.dispose()


def test_migrations_apply_roll_back_and_apply_again(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'roundtrip.db'}"
    config = alembic_config(url)
    command.upgrade(config, "head")
    engine = create_db_engine(url)
    assert {"campuses", "buildings", "meters", "readings", "ingest_batches"} <= set(inspect(engine).get_table_names())
    command.downgrade(config, "base")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}
    command.upgrade(config, "head")
    engine.dispose()


def test_the_database_enforces_its_own_rules(database_url: str) -> None:
    """A meter for a building that does not exist is refused by the database itself, not just by the API."""
    engine = create_db_engine(database_url)
    insert = (
        "INSERT INTO meters (building_id, kind, unit, created_at) VALUES (424242, 'measured', 'kW', CURRENT_TIMESTAMP)"
    )
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(text(insert))
    engine.dispose()
