"""Campuses and buildings."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Building


def test_lists_the_campuses_with_building_counts(client: TestClient, seeded: Session) -> None:
    campuses = {c["id"]: c for c in client.get("/campuses").json()}
    assert set(campuses) == {"iitgn", "mujaipur"}
    assert campuses["iitgn"]["building_count"] == 11 and campuses["mujaipur"]["building_count"] == 14
    assert campuses["mujaipur"]["name"] == "Manipal University Jaipur"
    assert campuses["iitgn"]["timezone"] == "Asia/Kolkata"


def test_lists_a_campuss_buildings_with_their_neighbourhoods(client: TestClient, seeded: Session) -> None:
    rows = client.get("/campuses/iitgn/buildings").json()
    assert len(rows) == 11 and {r["campus_id"] for r in rows} == {"iitgn"}
    assert all(r["confidence"] == "modelled" and r["last_reading_at"] is None for r in rows)
    assert any(r["neighbourhood"] for r in rows)
    outlined = [r for r in client.get("/campuses/mujaipur/buildings").json() if r["outline"]]
    assert outlined and all(len(r["outline"]) >= 3 for r in outlined)


def test_buildings_page(client: TestClient, seeded: Session) -> None:
    everything = client.get("/campuses/mujaipur/buildings").json()
    page = client.get("/campuses/mujaipur/buildings", params={"limit": 5, "offset": 5}).json()
    assert [b["id"] for b in page] == [b["id"] for b in everything[5:10]]
    assert client.get("/campuses/mujaipur/buildings", params={"limit": 0}).status_code == 422
    assert client.get("/campuses/mujaipur/buildings", params={"limit": 1001}).status_code == 422


def test_unknown_campus_and_building_are_404(client: TestClient, seeded: Session) -> None:
    assert client.get("/campuses/atlantis/buildings").status_code == 404
    assert client.get("/buildings/999999").status_code == 404
    assert client.get("/buildings/not-a-number").status_code == 422


def test_one_building(client: TestClient, seeded: Session) -> None:
    target = seeded.scalars(select(Building).where(Building.archetype == "chiller")).first()
    assert target is not None
    body = client.get(f"/buildings/{target.id}").json()
    assert body["id"] == target.id and body["archetype"] == "chiller" and body["rev"] == 1


def test_the_model_library_lists_the_five_campaigns(client: TestClient) -> None:
    body = client.get("/model").json()
    assert [c["key"] for c in body["campaigns"]] == ["ac26", "away", "shift", "standby", "swap"]
    assert len(body["archetypes"]) == 11
