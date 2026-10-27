"""Load the front end's building table into the database. Safe to run again.

    python -m app.seed [--file path/to/assets.js]

The table is web/app/data/assets.js, the same file the browser draws from, so there is one list of
buildings. Rows are matched on a stable ref (campus, name, and which one when a name repeats). A new row is
inserted, a changed row is updated and its revision bumped, and an unchanged row is left alone.

The table also carries a "measured" flag on six buildings. Those are demo flags for the front end's styling,
not meter data, so they are deliberately not imported: a building is measured here only once readings arrive.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import create_db_engine, create_session_factory
from app.models import Building, Campus, Neighbourhood
from app.simulation.model import ARCHETYPES, default_floors, polygon_area

CAMPUSES = {
    "iitgn": "IIT Gandhinagar",
    "mujaipur": "Manipal University Jaipur",
}
ROW_FIELDS = 13  # name, archetype, group, x, z, width, depth, height, solarKwp, measured, flag, outline, campus


@dataclass(frozen=True)
class SeedResult:
    created: int
    updated: int
    unchanged: int


def parse_assets(text: str) -> list[list[Any]]:
    """The array literal in `window.LIFECITY_ASSETS = [...]`. The file is plain JSON after the assignment."""
    match = re.search(r"window\.LIFECITY_ASSETS\s*=\s*(\[.*\])\s*;", text, re.DOTALL)
    if match is None:
        raise ValueError("no window.LIFECITY_ASSETS array found")
    rows = json.loads(match.group(1))
    for i, row in enumerate(rows):
        if len(row) != ROW_FIELDS:
            raise ValueError(f"row {i} has {len(row)} fields, expected {ROW_FIELDS}")
        if row[1] not in ARCHETYPES:
            raise ValueError(f"row {i} ({row[0]}) has unknown archetype {row[1]!r}")
        if row[12] not in CAMPUSES:
            raise ValueError(f"row {i} ({row[0]}) has unknown campus {row[12]!r}")
    return rows  # type: ignore[no-any-return]


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "building"


def _position_source(flag: str, outline: Any) -> str:
    if flag == "p":
        return "placeholder"
    if flag == "i":
        return "inferred"
    return "osm_footprint" if outline else "osm_point"


def seed_assets(session: Session, rows: list[list[Any]]) -> SeedResult:
    for campus_id, name in CAMPUSES.items():
        if session.get(Campus, campus_id) is None:
            session.add(Campus(id=campus_id, name=name, timezone="Asia/Kolkata"))
    session.flush()

    neighbourhoods = {(n.campus_id, n.name): n.id for n in session.scalars(select(Neighbourhood))}
    existing = {b.ref: b for b in session.scalars(select(Building))}
    seen_names: Counter[tuple[str, str]] = Counter()
    created = updated = unchanged = 0

    for name, archetype, group, x, z, width, depth, height, solar, _measured, flag, outline, campus in rows:
        slug = _slug(name)
        seen_names[(campus, slug)] += 1
        ref = f"{campus}:{slug}:{seen_names[(campus, slug)]}"

        hood = group.strip() if group else None
        hood_id = None
        if hood:
            if (campus, hood) not in neighbourhoods:
                row = Neighbourhood(campus_id=campus, name=hood)
                session.add(row)
                session.flush()
                neighbourhoods[(campus, hood)] = row.id
            hood_id = neighbourhoods[(campus, hood)]

        values: dict[str, Any] = {
            "campus_id": campus,
            "neighbourhood_id": hood_id,
            "name": name,
            "archetype": archetype,
            "x_m": float(x),
            "z_m": float(z),
            "width_m": float(width),
            "depth_m": float(depth),
            "height_m": float(height),
            "floors": default_floors(float(height)),
            "footprint_m2": polygon_area(outline) if outline else float(width) * float(depth),
            "solar_kwp": float(solar),
            "outline": outline or None,
            "position_source": _position_source(flag, outline),
        }
        current = existing.get(ref)
        if current is None:
            session.add(Building(ref=ref, **values))
            created += 1
        elif any(getattr(current, key) != value for key, value in values.items()):
            for key, value in values.items():
                setattr(current, key, value)
            current.rev += 1
            updated += 1
        else:
            unchanged += 1
    session.commit()
    return SeedResult(created, updated, unchanged)


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the building table.")
    parser.add_argument("--file", type=Path, default=None, help="path to assets.js")
    args = parser.parse_args()

    settings = get_settings()
    path = args.file or settings.assets_file
    rows = parse_assets(path.read_text(encoding="utf-8"))
    engine = create_db_engine(settings.database_url)
    with create_session_factory(engine)() as session:
        result = seed_assets(session, rows)
    engine.dispose()
    print(
        f"seeded {len(rows)} rows from {path}: "
        f"{result.created} created, {result.updated} updated, {result.unchanged} unchanged"
    )


if __name__ == "__main__":
    main()
