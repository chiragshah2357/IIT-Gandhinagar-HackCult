"""Reading campuses and buildings."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Building, Campus, Meter, Neighbourhood, Reading
from app.schemas import BuildingOut, CampusOut, ReadingOut


def list_campuses(session: Session) -> list[CampusOut]:
    counts = {
        campus: n
        for campus, n in session.execute(
            select(Building.campus_id, func.count(Building.id)).group_by(Building.campus_id)
        )
    }
    return [
        CampusOut(id=c.id, name=c.name, timezone=c.timezone, building_count=counts.get(c.id, 0))
        for c in session.scalars(select(Campus).order_by(Campus.id))
    ]


def campus_exists(session: Session, campus_id: str) -> bool:
    return session.get(Campus, campus_id) is not None


def _last_reading_times(session: Session) -> dict[int, datetime]:
    """When each building last reported. Only buildings with a measured meter appear."""
    rows = session.execute(
        select(Meter.building_id, func.max(Reading.ts))
        .join(Reading, Reading.meter_id == Meter.id)
        .where(Meter.kind == "measured")
        .group_by(Meter.building_id)
    )
    return {building_id: ts for building_id, ts in rows}


def _to_out(building: Building, neighbourhood: str | None, last: datetime | None) -> BuildingOut:
    return BuildingOut(
        id=building.id,
        ref=building.ref,
        campus_id=building.campus_id,
        neighbourhood=neighbourhood,
        name=building.name,
        archetype=building.archetype,
        x_m=building.x_m,
        z_m=building.z_m,
        width_m=building.width_m,
        depth_m=building.depth_m,
        height_m=building.height_m,
        floors=building.floors,
        footprint_m2=building.footprint_m2,
        solar_kwp=building.solar_kwp,
        outline=building.outline,
        position_source=building.position_source,
        rev=building.rev,
        confidence="measured" if last is not None else "modelled",
        last_reading_at=last,
    )


def list_buildings(session: Session, campus_id: str, *, limit: int, offset: int) -> list[BuildingOut]:
    last = _last_reading_times(session)
    rows = session.execute(
        select(Building, Neighbourhood.name)
        .outerjoin(Neighbourhood, Neighbourhood.id == Building.neighbourhood_id)
        .where(Building.campus_id == campus_id)
        .order_by(Building.id)
        .limit(limit)
        .offset(offset)
    )
    return [_to_out(b, n, last.get(b.id)) for b, n in rows]


def get_building(session: Session, building_id: int) -> BuildingOut | None:
    row = session.execute(
        select(Building, Neighbourhood.name)
        .outerjoin(Neighbourhood, Neighbourhood.id == Building.neighbourhood_id)
        .where(Building.id == building_id)
    ).first()
    if row is None:
        return None
    building, neighbourhood = row
    last = session.scalar(
        select(func.max(Reading.ts))
        .join(Meter, Meter.id == Reading.meter_id)
        .where(Meter.building_id == building_id, Meter.kind == "measured")
    )
    return _to_out(building, neighbourhood, last)


def list_readings(
    session: Session, building_id: int, *, start: datetime | None, end: datetime | None, limit: int
) -> list[ReadingOut]:
    stmt = (
        select(Reading.ts, Reading.value_kw)
        .join(Meter, Meter.id == Reading.meter_id)
        .where(Meter.building_id == building_id, Meter.kind == "measured")
        .order_by(Reading.ts)
        .limit(limit)
    )
    if start is not None:
        stmt = stmt.where(Reading.ts >= start)
    if end is not None:
        stmt = stmt.where(Reading.ts < end)
    return [ReadingOut(ts=ts, kw=kw) for ts, kw in session.execute(stmt)]
