"""Request and response shapes. Everything that comes in is validated here before it touches the database."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator

from app.simulation.model import CAMPAIGN_KEYS, Band, DayType

MAX_BATCH_READINGS = 5_000
MAX_KW = 200_000.0  # far above any building here; a typo guard, not a physical claim

CampaignKey = Literal["ac26", "away", "shift", "standby", "swap"]
CampusId = Annotated[str, Field(pattern=r"^[a-z0-9_-]{1,32}$")]


class CampusOut(BaseModel):
    id: str
    name: str
    timezone: str
    building_count: int


class BuildingOut(BaseModel):
    id: int
    ref: str
    campus_id: str
    neighbourhood: str | None
    name: str
    archetype: str
    x_m: float
    z_m: float
    width_m: float
    depth_m: float
    height_m: float
    floors: int
    footprint_m2: float
    solar_kwp: float
    outline: list[list[float]] | None
    position_source: str
    rev: int
    # "measured" only when real readings have been ingested for the building. Every load is modelled today.
    confidence: Literal["measured", "modelled"]
    last_reading_at: datetime | None


# ---------------------------------------------------------------- readings


class ReadingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    building_id: int = Field(gt=0)
    ts: AwareDatetime  # must carry a timezone; stored as UTC
    kw: float = Field(ge=0, le=MAX_KW, allow_inf_nan=False)  # average power at ts


class ReadingsBatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    readings: list[ReadingIn] = Field(min_length=1, max_length=MAX_BATCH_READINGS)


class ReadingsBatchOut(BaseModel):
    idempotency_key: str
    accepted: int
    duplicates: int
    # True when this key was seen before with the same payload: nothing was written this time.
    replayed: bool


class ReadingOut(BaseModel):
    ts: datetime
    kw: float


# ---------------------------------------------------------------- simulation


def _every_campaign() -> list[CampaignKey]:
    return ["ac26", "away", "shift", "standby", "swap"]


class SimulateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    campus: CampusId = "all"
    campaigns: list[CampaignKey] = Field(default_factory=_every_campaign)
    day_type: DayType = "weekday"
    include_buildings: bool = False

    @field_validator("campaigns")
    @classmethod
    def _canonical(cls, value: list[str]) -> list[str]:
        """Order and de-duplicate, so the same set of campaigns always means the same request."""
        return [key for key in CAMPAIGN_KEYS if key in value]


class BandResult(BaseModel):
    kw: list[float]
    saved_kwh: float
    carbon_avoided_kg: float
    bill_saved_inr: float
    peak_kw: float
    peak_shaved_kw: float


class BuildingLoad(BaseModel):
    id: int
    name: str
    archetype: str
    baseline_kw: list[float]
    bands: dict[Band, list[float]]


class SimulateOut(BaseModel):
    model_version: str
    params_hash: str
    campus: str
    campaigns: list[str]
    day_type: DayType
    hours: list[int]
    building_count: int
    measured_buildings: int
    baseline_kw: list[float]
    baseline_kwh: float
    baseline_peak_kw: float
    carbon_g_per_kwh: list[float]
    tariff_inr_per_kwh: float
    # low, mid and high are the three effect cases of the campaigns, not statistical bounds.
    bands: dict[Band, BandResult]
    buildings: list[BuildingLoad] | None = None
    notes: list[str]


class CampaignOut(BaseModel):
    key: str
    label: str
    note: str
    summary: str


class ArchetypeOut(BaseModel):
    key: str
    label: str


class ModelOut(BaseModel):
    model_version: str
    campaigns: list[CampaignOut]
    archetypes: list[ArchetypeOut]
