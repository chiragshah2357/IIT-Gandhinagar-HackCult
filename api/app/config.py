"""Settings, read from the environment (prefix LIFECITY_) or an .env file. Nothing secret has a default."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LIFECITY_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://lifecity:lifecity@localhost:5432/lifecity"

    # Writes need this key (header X-API-Key). Unset means ingestion is switched off, never open.
    ingest_api_key: SecretStr | None = None

    # The seed table the front end also reads, so there is one list of buildings.
    assets_file: Path = _REPO_ROOT / "web" / "app" / "data" / "assets.js"

    # Origins allowed to call the API from a browser. Empty means same-origin only.
    cors_origins: list[str] = Field(default_factory=list)

    max_body_bytes: int = 2_000_000
    # Per client address, per minute, for the POST routes. 0 switches the limit off.
    rate_limit_per_minute: int = 120

    tariff_inr_per_kwh: float = 7.5  # a placeholder, like every price in the model
    cache_max_entries: int = 128
    log_level: str = "INFO"


@lru_cache
def get_settings() -> Settings:
    return Settings()
