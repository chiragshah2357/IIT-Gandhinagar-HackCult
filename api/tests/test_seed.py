"""Seeding the building table from the front end's file."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Building, Campus, Meter, Neighbourhood
from app.seed import ROW_FIELDS, parse_assets, seed_assets
from tests.conftest import SAMPLE_ASSETS

REAL_ASSETS = Path(__file__).resolve().parents[2] / "web" / "app" / "data" / "assets.js"


def sample_rows() -> list[list[object]]:
    return parse_assets(SAMPLE_ASSETS.read_text(encoding="utf-8"))


def test_parses_the_sample_table() -> None:
    rows = sample_rows()
    assert len(rows) == 25
    assert all(len(r) == ROW_FIELDS for r in rows)


@pytest.mark.skipif(not REAL_ASSETS.exists(), reason="the web app is not in this checkout")
def test_parses_the_real_table() -> None:
    rows = parse_assets(REAL_ASSETS.read_text(encoding="utf-8"))
    assert len(rows) == 190
    assert {r[12] for r in rows} == {"iitgn", "mujaipur"}


def test_rejects_a_file_with_no_table() -> None:
    with pytest.raises(ValueError, match="LIFECITY_ASSETS"):
        parse_assets("const nothing = [];")


def test_rejects_unknown_archetypes_campuses_and_short_rows() -> None:
    good = json.dumps(sample_rows()[0])
    bad_archetype = json.loads(good)
    bad_archetype[1] = "castle"
    bad_campus = json.loads(good)
    bad_campus[12] = "elsewhere"
    for row, message in ((bad_archetype, "archetype"), (bad_campus, "campus"), (json.loads(good)[:5], "fields")):
        with pytest.raises(ValueError, match=message):
            parse_assets(f"window.LIFECITY_ASSETS = {json.dumps([row])};")


def test_creates_campuses_neighbourhoods_and_buildings(session: Session) -> None:
    result = seed_assets(session, sample_rows())
    assert (result.created, result.updated, result.unchanged) == (25, 0, 0)
    assert session.scalar(select(func.count(Campus.id))) == 2
    assert session.scalar(select(func.count(Building.id))) == 25
    assert session.scalar(select(func.count(Neighbourhood.id))) >= 2


def test_seeding_twice_changes_nothing(session: Session) -> None:
    seed_assets(session, sample_rows())
    before = {b.ref: (b.id, b.rev, b.updated_at) for b in session.scalars(select(Building))}
    again = seed_assets(session, sample_rows())
    assert (again.created, again.updated, again.unchanged) == (0, 0, 25)
    assert {b.ref: (b.id, b.rev, b.updated_at) for b in session.scalars(select(Building))} == before


def test_a_changed_row_is_updated_and_its_revision_bumped(session: Session) -> None:
    rows = sample_rows()
    seed_assets(session, rows)
    target = rows[3]
    target[7] = float(target[7]) + 10  # a taller building
    result = seed_assets(session, rows)
    assert (result.created, result.updated, result.unchanged) == (0, 1, 24)
    changed = session.scalar(select(Building).where(Building.name == target[0], Building.campus_id == target[12]))
    assert changed is not None and changed.rev == 2 and changed.height_m == target[7]


def test_repeated_names_get_distinct_stable_refs(session: Session) -> None:
    seed_assets(session, sample_rows())
    refs = sorted(session.scalars(select(Building.ref).where(Building.name == "Faculty Apartment")))
    assert refs == [f"mujaipur:faculty-apartment:{n}" for n in (1, 2, 3)]


def test_the_demo_measured_flags_are_not_imported(seeded: Session) -> None:
    """Six rows in the table are marked measured for the front end's styling. No meter exists for any of them."""
    assert any(r[9] == 1 for r in sample_rows())
    assert seeded.scalar(select(func.count(Meter.id))) == 0


def test_position_sources_follow_the_flags(seeded: Session) -> None:
    sources = {b.name: b.position_source for b in seeded.scalars(select(Building))}
    assert sources["Chiller plant"] == "placeholder"
    assert set(sources.values()) <= {"osm_footprint", "osm_point", "inferred", "placeholder"}
    assert "inferred" in sources.values() and "osm_footprint" in sources.values() and "osm_point" in sources.values()


def test_boxes_use_width_times_depth_and_outlines_use_their_area(seeded: Session) -> None:
    for b in seeded.scalars(select(Building)):
        if b.outline is None:
            assert b.footprint_m2 == pytest.approx(b.width_m * b.depth_m)
        else:
            assert b.footprint_m2 > 0 and len(b.outline) >= 3
        assert b.floors == max(1, int(b.height_m / 3.4 + 0.5))
