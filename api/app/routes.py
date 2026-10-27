"""The HTTP surface. Routes stay thin: validate, call a service, shape the response."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from sqlalchemy import text
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.orm import Session

from app.db import get_session
from app.guards import rate_limit, require_ingest_key
from app.schemas import (
    ArchetypeOut,
    BuildingOut,
    CampaignOut,
    CampusOut,
    ModelOut,
    ReadingOut,
    ReadingsBatchIn,
    ReadingsBatchOut,
    SimulateIn,
    SimulateOut,
)
from app.services import buildings as building_service
from app.services import ingest, scenario
from app.simulation.model import ARCHETYPES, CAMPAIGNS, MODEL_VERSION

router = APIRouter()
SessionDep = Annotated[Session, Depends(get_session)]
IdempotencyKey = Annotated[
    str,
    Header(
        alias="Idempotency-Key", pattern=r"^[A-Za-z0-9._:-]{8,128}$", description="Unique per batch; reuse it to retry."
    ),
]


# ------------------------------------------------------------------ operations


@router.get("/healthz", tags=["operations"])
def healthz() -> dict[str, str]:
    """The process is up. Says nothing about the database; see /readyz."""
    return {"status": "ok"}


@router.get("/readyz", tags=["operations"])
def readyz(session: SessionDep, response: Response) -> dict[str, str]:
    """Ready when the database answers. A load balancer should send traffic only to ready instances."""
    try:
        session.execute(text("SELECT 1"))
    except (OperationalError, InterfaceError):
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "database unavailable"}
    return {"status": "ready"}


# ------------------------------------------------------------------ the model


@router.get("/model", tags=["model"], response_model=ModelOut)
def model_library() -> ModelOut:
    """The building types and campaigns the simulation knows, so a client can draw them without hard-coding."""
    return ModelOut(
        model_version=MODEL_VERSION,
        campaigns=[CampaignOut(key=c.key, label=c.label, note=c.note, summary=c.summary) for c in CAMPAIGNS],
        archetypes=[ArchetypeOut(key=a.key, label=a.label) for a in ARCHETYPES.values()],
    )


# ------------------------------------------------------------------ campuses and buildings


@router.get("/campuses", tags=["buildings"], response_model=list[CampusOut])
def campuses(session: SessionDep) -> list[CampusOut]:
    return building_service.list_campuses(session)


@router.get("/campuses/{campus_id}/buildings", tags=["buildings"], response_model=list[BuildingOut])
def campus_buildings(
    campus_id: str,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[BuildingOut]:
    if not building_service.campus_exists(session, campus_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown campus")
    return building_service.list_buildings(session, campus_id, limit=limit, offset=offset)


@router.get("/buildings/{building_id}", tags=["buildings"], response_model=BuildingOut)
def building(building_id: int, session: SessionDep) -> BuildingOut:
    found = building_service.get_building(session, building_id)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown building")
    return found


@router.get("/buildings/{building_id}/readings", tags=["readings"], response_model=list[ReadingOut])
def building_readings(
    building_id: int,
    session: SessionDep,
    start: Annotated[datetime | None, Query(alias="from")] = None,
    end: Annotated[datetime | None, Query(alias="to")] = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 1000,
) -> list[ReadingOut]:
    """Stored readings for a building, oldest first. `from` is inclusive, `to` exclusive."""
    for name, value in (("from", start), ("to", end)):
        if value is not None and value.tzinfo is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"'{name}' needs a timezone offset")
    if building_service.get_building(session, building_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown building")
    return building_service.list_readings(session, building_id, start=start, end=end, limit=limit)


# ------------------------------------------------------------------ ingestion


@router.post(
    "/readings:batch",
    tags=["readings"],
    response_model=ReadingsBatchOut,
    dependencies=[Depends(require_ingest_key), Depends(rate_limit)],
    responses={
        401: {"description": "Missing or wrong X-API-Key"},
        409: {"description": "Idempotency-Key was already used for a different batch"},
        422: {"description": "A reading is invalid; nothing was written"},
    },
)
def post_readings(
    payload: ReadingsBatchIn,
    idempotency_key: IdempotencyKey,
    session: SessionDep,
) -> ReadingsBatchOut:
    """Ingest power readings. All or nothing, and safe to retry with the same Idempotency-Key."""
    try:
        outcome = ingest.ingest_batch(session, key=idempotency_key, readings=payload.readings)
    except ingest.UnknownBuildings as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    except (ingest.BadTimestamps, ingest.ConflictingReadings) as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    except ingest.IdempotencyConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return ReadingsBatchOut(
        idempotency_key=idempotency_key,
        accepted=outcome.accepted,
        duplicates=outcome.duplicates,
        replayed=outcome.replayed,
    )


# ------------------------------------------------------------------ simulation


@router.post(
    "/scenarios/simulate",
    tags=["simulation"],
    response_model=SimulateOut,
    dependencies=[Depends(rate_limit)],
)
def simulate(payload: SimulateIn, request: Request, response: Response, session: SessionDep) -> SimulateOut:
    """Hourly campus load with and without the chosen Mission LiFE campaigns, for one day type.

    Cached by the request's parameters. The X-Cache header says HIT, MISS or STALE (the database was unreachable
    and the last answer is served instead).
    """
    cache: scenario.ScenarioCache = request.app.state.scenario_cache
    digest = scenario.params_hash(payload)
    try:
        version = scenario.data_version(session)
    except (OperationalError, InterfaceError):
        stale = cache.get(digest)
        if stale is None:
            raise
        response.headers["X-Cache"] = "STALE"
        response.headers["Warning"] = '110 - "Response is stale: the database is unavailable"'
        return stale.result

    cached = cache.get(digest)
    if cached is not None and cached.data_version == version:
        response.headers["X-Cache"] = "HIT"
        return cached.result

    if payload.campus != "all" and not building_service.campus_exists(session, payload.campus):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown campus")
    result = scenario.simulate(
        scenario.load_buildings(session, payload.campus),
        campus=payload.campus,
        campaigns=payload.campaigns,
        day_type=payload.day_type,
        include_buildings=payload.include_buildings,
        tariff_inr_per_kwh=request.app.state.settings.tariff_inr_per_kwh,
        digest=digest,
    )
    cache.put(digest, scenario.CacheEntry(version, result))
    response.headers["X-Cache"] = "MISS"
    return result
