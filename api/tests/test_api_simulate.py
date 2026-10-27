"""Scenario simulation over HTTP: shape, correctness, caching, degraded mode and limits."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.config import Settings
from app.main import create_app
from app.models import Building
from app.services import scenario
from app.simulation import model as m

PATH = "/scenarios/simulate"


def run(client: TestClient, **body: Any):
    return client.post(PATH, json=body)


def expected_baseline(session: Session, campus: str = "all") -> list[float]:
    """The baseline computed straight from the model and the stored buildings, with no API in between."""
    stmt = select(Building)
    if campus != "all":
        stmt = stmt.where(Building.campus_id == campus)
    hours = [0.0] * 24
    for b in session.scalars(stmt):
        peak = m.peak_kw(b.archetype, b.footprint_m2, b.floors, b.calibration)
        for h, v in enumerate(m.unit_profile(b.archetype, [], "weekday").baseline):
            hours[h] += peak * v
    return hours


def test_response_shape(client: TestClient, seeded: Session) -> None:
    body = run(client).json()
    assert body["model_version"] == m.MODEL_VERSION
    assert body["hours"] == list(range(24))
    assert len(body["baseline_kw"]) == len(body["carbon_g_per_kwh"]) == 24
    assert set(body["bands"]) == {"low", "mid", "high"}
    assert all(len(b["kw"]) == 24 for b in body["bands"].values())
    assert body["building_count"] == 25 and body["measured_buildings"] == 0
    assert body["campaigns"] == list(m.CAMPAIGN_KEYS) and body["day_type"] == "weekday"
    assert "modelled" in " ".join(body["notes"])


def test_baseline_matches_the_model_applied_to_the_stored_buildings(client: TestClient, seeded: Session) -> None:
    assert run(client).json()["baseline_kw"] == pytest.approx(expected_baseline(seeded), abs=2e-3)
    assert run(client, campus="mujaipur").json()["baseline_kw"] == pytest.approx(
        expected_baseline(seeded, "mujaipur"), abs=2e-3
    )


def test_campuses_add_up_to_the_whole(client: TestClient, seeded: Session) -> None:
    whole = run(client, campus="all").json()
    parts = [run(client, campus=c).json() for c in ("iitgn", "mujaipur")]
    assert sum(p["building_count"] for p in parts) == whole["building_count"]
    summed = [sum(p["baseline_kw"][h] for p in parts) for h in range(24)]
    assert summed == pytest.approx(whole["baseline_kw"], abs=5e-3)
    for band in ("low", "mid", "high"):
        total = sum(p["bands"][band]["saved_kwh"] for p in parts)
        assert total == pytest.approx(whole["bands"][band]["saved_kwh"], abs=5e-3)


def test_effect_cases_are_ordered_and_savings_are_positive(client: TestClient, seeded: Session) -> None:
    bands = run(client).json()["bands"]
    saved = [bands[b]["saved_kwh"] for b in ("low", "mid", "high")]
    assert 0 < saved[0] < saved[1] < saved[2]
    assert all(bands[b]["carbon_avoided_kg"] > 0 and bands[b]["bill_saved_inr"] > 0 for b in bands)
    assert bands["mid"]["bill_saved_inr"] == pytest.approx(bands["mid"]["saved_kwh"] * 7.5, abs=0.01)
    assert all(min(bands[b]["kw"]) >= 0 for b in bands)


def test_no_campaigns_means_no_savings(client: TestClient, seeded: Session) -> None:
    body = run(client, campaigns=[]).json()
    for band in body["bands"].values():
        assert band["kw"] == body["baseline_kw"]
        assert band["saved_kwh"] == 0 and band["peak_shaved_kw"] == 0


def test_more_campaigns_save_more(client: TestClient, seeded: Session) -> None:
    one = run(client, campaigns=["ac26"]).json()["bands"]["mid"]["saved_kwh"]
    two = run(client, campaigns=["ac26", "away"]).json()["bands"]["mid"]["saved_kwh"]
    assert 0 < one < two


def test_the_weekend_differs(client: TestClient, seeded: Session) -> None:
    assert run(client, day_type="weekend").json()["baseline_kw"] != run(client).json()["baseline_kw"]


def test_per_building_detail_adds_up_to_the_totals(client: TestClient, seeded: Session) -> None:
    body = run(client, include_buildings=True).json()
    assert len(body["buildings"]) == 25
    summed = [sum(b["baseline_kw"][h] for b in body["buildings"]) for h in range(24)]
    assert summed == pytest.approx(body["baseline_kw"], abs=0.05)
    assert run(client).json()["buildings"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"campaigns": ["not-a-campaign"]},
        {"day_type": "holiday"},
        {"campus": "Bad Campus!"},
        {"extra": 1},
        {"include_buildings": "maybe"},
    ],
)
def test_invalid_requests_are_refused(client: TestClient, seeded: Session, body: dict[str, Any]) -> None:
    assert client.post(PATH, json=body).status_code == 422


def test_an_unknown_campus_is_a_404_and_is_not_cached(client: TestClient, seeded: Session) -> None:
    assert run(client, campus="atlantis").status_code == 404
    assert run(client, campus="atlantis").status_code == 404


def test_an_empty_database_simulates_to_zero(client: TestClient) -> None:
    body = run(client).json()
    assert body["building_count"] == 0 and body["baseline_kw"] == [0.0] * 24


# ---------------------------------------------------------------- caching


def test_second_identical_request_is_a_cache_hit(client: TestClient, seeded: Session) -> None:
    first, second = run(client), run(client)
    assert (first.headers["X-Cache"], second.headers["X-Cache"]) == ("MISS", "HIT")
    assert first.json() == second.json()


def test_the_same_campaigns_in_any_order_share_one_cache_entry(client: TestClient, seeded: Session) -> None:
    first = run(client, campaigns=["swap", "ac26", "ac26"])
    second = run(client, campaigns=["ac26", "swap"])
    assert second.headers["X-Cache"] == "HIT"
    assert first.json()["params_hash"] == second.json()["params_hash"]
    assert first.json()["campaigns"] == ["ac26", "swap"]


def test_different_parameters_do_not_share_an_entry(client: TestClient, seeded: Session) -> None:
    run(client)
    assert run(client, day_type="weekend").headers["X-Cache"] == "MISS"
    assert run(client, campus="iitgn").headers["X-Cache"] == "MISS"


def test_changing_a_building_invalidates_the_cache(client: TestClient, seeded: Session) -> None:
    before = run(client).json()
    assert run(client).headers["X-Cache"] == "HIT"
    target = seeded.scalars(select(Building).where(Building.archetype == "hostel")).first()
    assert target is not None
    target.calibration = 2.0
    target.rev += 1
    seeded.commit()
    after = run(client)
    assert after.headers["X-Cache"] == "MISS"
    assert after.json()["baseline_kw"] != before["baseline_kw"]


def test_new_readings_invalidate_the_cache_and_show_in_the_count(
    client: TestClient, seeded: Session, auth: dict[str, str]
) -> None:
    assert run(client).json()["measured_buildings"] == 0
    building_id = seeded.scalars(select(Building.id)).first()
    stamp = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    client.post(
        "/readings:batch",
        json={"readings": [{"building_id": building_id, "ts": stamp, "kw": 12.5}]},
        headers={"Idempotency-Key": "batch-00000001", **auth},
    )
    after = run(client)
    assert after.headers["X-Cache"] == "MISS" and after.json()["measured_buildings"] == 1


def test_the_cache_is_bounded(settings: Settings, seeded: Session) -> None:
    app = create_app(settings.model_copy(update={"cache_max_entries": 2}))
    with TestClient(app) as client:
        for campaigns in (["ac26"], ["away"], ["swap"]):
            run(client, campaigns=campaigns)
        assert len(app.state.scenario_cache) == 2
        assert run(client, campaigns=["ac26"]).headers["X-Cache"] == "MISS"  # the oldest was evicted


# ---------------------------------------------------------------- degraded mode and limits


def test_when_the_database_is_down_the_last_answer_is_served_as_stale(
    client: TestClient, seeded: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    fresh = run(client).json()

    def down(_: Session) -> str:
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))

    monkeypatch.setattr(scenario, "data_version", down)
    stale = run(client)
    assert stale.status_code == 200 and stale.headers["X-Cache"] == "STALE"
    assert "stale" in stale.headers["Warning"].lower()
    assert stale.json() == fresh
    # Nothing cached for these parameters, so there is nothing honest to serve: a clear 503, not an error page.
    unseen = run(client, day_type="weekend")
    assert unseen.status_code == 503 and unseen.json() == {"detail": "database unavailable"}


def test_the_rate_limit_stops_a_flood_and_says_when_to_retry(settings: Settings, seeded: Session) -> None:
    app = create_app(settings.model_copy(update={"rate_limit_per_minute": 3}))
    with TestClient(app) as client:
        responses = [run(client) for _ in range(5)]
    assert [r.status_code for r in responses] == [200, 200, 200, 429, 429]
    assert int(responses[3].headers["Retry-After"]) >= 1
