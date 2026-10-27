"""Scenario simulation: load the buildings, run the model, shape the answer, and cache it.

The cache is keyed by the request's parameters and remembers which version of the data it was computed
from. A request is answered from the cache only while that version is still current, so adding or changing
a building, or the first readings arriving, invalidates it. If the database is unreachable the last answer is
served as stale rather than an error page (degraded mode).
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Building, Meter
from app.schemas import BandResult, BuildingLoad, SimulateIn, SimulateOut
from app.simulation.model import (
    BANDS,
    HOURS,
    MODEL_VERSION,
    DayType,
    carbon_intensity,
    peak_kw,
    unit_profile,
)

NOTES = [
    "Every load is modelled from building-type profiles. No meter data is used yet.",
    "Campaign effect ranges and the carbon curve are placeholders, not sourced figures.",
    "low, mid and high are three effect cases of the campaigns, not statistical bounds.",
]


@dataclass(frozen=True)
class BuildingInput:
    id: int
    name: str
    archetype: str
    kw_peak: float
    measured: bool


def params_hash(params: SimulateIn) -> str:
    """The same request always hashes the same, whatever order the campaigns were listed in."""
    canonical = {
        "model": MODEL_VERSION,
        "campus": params.campus,
        "campaigns": params.campaigns,
        "day_type": params.day_type,
        "include_buildings": params.include_buildings,
    }
    return hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()[:32]


def data_version(session: Session) -> str:
    """A cheap fingerprint of everything a simulation depends on. Changes when any of it does."""
    count, revisions, newest = session.execute(
        select(func.count(Building.id), func.coalesce(func.sum(Building.rev), 0), func.max(Building.updated_at))
    ).one()
    meters = session.scalar(select(func.count(Meter.id)).where(Meter.kind == "measured")) or 0
    return f"{count}:{revisions}:{newest.isoformat() if newest else ''}:{meters}"


def load_buildings(session: Session, campus: str) -> list[BuildingInput]:
    metered = select(Meter.building_id).where(Meter.kind == "measured")
    stmt = select(
        Building.id,
        Building.name,
        Building.archetype,
        Building.footprint_m2,
        Building.floors,
        Building.calibration,
        Building.id.in_(metered),
    ).order_by(Building.id)
    if campus != "all":
        stmt = stmt.where(Building.campus_id == campus)
    return [
        BuildingInput(
            id=bid,
            name=name,
            archetype=archetype,
            kw_peak=peak_kw(archetype, footprint, floors, calibration),
            measured=bool(has_meter),
        )
        for bid, name, archetype, footprint, floors, calibration, has_meter in session.execute(stmt)
    ]


def _r(values: Sequence[float]) -> list[float]:
    return [round(v, 3) for v in values]


def simulate(
    buildings: Sequence[BuildingInput],
    *,
    campus: str,
    campaigns: Sequence[str],
    day_type: DayType,
    include_buildings: bool,
    tariff_inr_per_kwh: float,
    digest: str,
) -> SimulateOut:
    # The model is linear in peak load, so each building kind is simulated once and scaled per building.
    peak_by_kind: dict[str, float] = defaultdict(float)
    for b in buildings:
        peak_by_kind[b.archetype] += b.kw_peak
    profiles = {kind: unit_profile(kind, campaigns, day_type) for kind in peak_by_kind}

    baseline = [sum(peak_by_kind[k] * profiles[k].baseline[h] for k in profiles) for h in range(HOURS)]
    intensity = [carbon_intensity(h) for h in range(HOURS)]
    baseline_peak = max(baseline, default=0.0)

    bands: dict[str, BandResult] = {}
    for band in BANDS:
        kw = [sum(peak_by_kind[k] * profiles[k].cases[band][h] for k in profiles) for h in range(HOURS)]
        saved = [baseline[h] - kw[h] for h in range(HOURS)]
        saved_kwh = sum(saved)  # hourly kW over one hour each
        peak = max(kw, default=0.0)
        bands[band] = BandResult(
            kw=_r(kw),
            saved_kwh=round(saved_kwh, 3),
            carbon_avoided_kg=round(sum(s * g for s, g in zip(saved, intensity, strict=True)) / 1000, 3),
            bill_saved_inr=round(saved_kwh * tariff_inr_per_kwh, 2),
            peak_kw=round(peak, 3),
            peak_shaved_kw=round(baseline_peak - peak, 3),
        )

    detail: list[BuildingLoad] | None = None
    if include_buildings:
        detail = []
        for b in buildings:
            p = profiles[b.archetype]
            detail.append(
                BuildingLoad(
                    id=b.id,
                    name=b.name,
                    archetype=b.archetype,
                    baseline_kw=_r([b.kw_peak * v for v in p.baseline]),
                    bands={band: _r([b.kw_peak * v for v in p.cases[band]]) for band in BANDS},
                )
            )

    return SimulateOut(
        model_version=MODEL_VERSION,
        params_hash=digest,
        campus=campus,
        campaigns=list(campaigns),
        day_type=day_type,
        hours=list(range(HOURS)),
        building_count=len(buildings),
        measured_buildings=sum(1 for b in buildings if b.measured),
        baseline_kw=_r(baseline),
        baseline_kwh=round(sum(baseline), 3),
        baseline_peak_kw=round(baseline_peak, 3),
        carbon_g_per_kwh=_r(intensity),
        tariff_inr_per_kwh=tariff_inr_per_kwh,
        bands=bands,
        buildings=detail,
        notes=NOTES,
    )


@dataclass(frozen=True)
class CacheEntry:
    data_version: str
    result: SimulateOut


class ScenarioCache:
    """A small thread-safe LRU. The simulation is a few milliseconds, so this is about not repeating it."""

    def __init__(self, max_entries: int) -> None:
        self._max = max(1, max_entries)
        self._items: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> CacheEntry | None:
        with self._lock:
            entry = self._items.get(key)
            if entry is not None:
                self._items.move_to_end(key)
            return entry

    def put(self, key: str, entry: CacheEntry) -> None:
        with self._lock:
            self._items[key] = entry
            self._items.move_to_end(key)
            while len(self._items) > self._max:
                self._items.popitem(last=False)

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)
