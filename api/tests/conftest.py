"""Test setup.

Tests run on whatever LIFECITY_TEST_DATABASE_URL points at (CI uses a real Postgres) and fall back to a
temporary SQLite file. Either way the schema is built by the Alembic migrations, so the migrations are what
is tested, and each test starts from empty tables.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic.config import Config
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from alembic import command
from app.config import Settings
from app.db import create_db_engine, create_session_factory
from app.main import create_app
from app.models import Base
from app.seed import parse_assets, seed_assets

API_DIR = Path(__file__).resolve().parents[1]
SAMPLE_ASSETS = Path(__file__).parent / "fixtures" / "assets_sample.js"
INGEST_KEY = "test-ingest-key-0123456789"


def alembic_config(url: str) -> Config:
    config = Config(str(API_DIR / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    return config


@pytest.fixture(scope="session")
def database_url(tmp_path_factory: pytest.TempPathFactory) -> str:
    url = os.environ.get("LIFECITY_TEST_DATABASE_URL") or f"sqlite:///{tmp_path_factory.mktemp('db') / 'test.db'}"
    engine = create_db_engine(url)
    if engine.dialect.name == "postgresql":
        with engine.begin() as connection:
            connection.execute(text("DROP SCHEMA public CASCADE"))
            connection.execute(text("CREATE SCHEMA public"))
    engine.dispose()
    command.upgrade(alembic_config(url), "head")
    return url


@pytest.fixture(scope="session")
def engine_factory(database_url: str) -> sessionmaker[Session]:
    return create_session_factory(create_db_engine(database_url))


@pytest.fixture(autouse=True)
def clean_tables(database_url: str, engine_factory: sessionmaker[Session]) -> Iterator[None]:
    """Every test starts with empty tables, children before parents."""
    yield
    with engine_factory() as session:
        for table in reversed(Base.metadata.sorted_tables):
            session.execute(table.delete())
        session.commit()


@pytest.fixture
def settings(database_url: str) -> Settings:
    return Settings(
        database_url=database_url,
        ingest_api_key=INGEST_KEY,  # type: ignore[arg-type]
        rate_limit_per_minute=0,
        cors_origins=["http://localhost:5191"],
        log_level="WARNING",
    )


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def session(app: FastAPI) -> Iterator[Session]:
    with app.state.session_factory() as db:
        yield db


@pytest.fixture
def seeded(session: Session) -> Session:
    """The sample building table loaded into an empty database."""
    seed_assets(session, parse_assets(SAMPLE_ASSETS.read_text(encoding="utf-8")))
    return session


@pytest.fixture
def auth() -> dict[str, str]:
    return {"X-API-Key": INGEST_KEY}
