"""Reading ingestion over HTTP: auth, validation, atomicity, idempotency and duplicates."""

from __future__ import annotations

import threading
from datetime import UTC, datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings
from app.main import create_app
from app.models import Building, IngestBatch, Meter, Reading
from app.schemas import ReadingIn
from app.services.ingest import ingest_batch

NOW = datetime.now(UTC).replace(microsecond=0)


def stamp(hours_ago: int) -> str:
    return (NOW - timedelta(hours=hours_ago)).isoformat()


def reading(building_id: int, hours_ago: int, kw: float) -> dict[str, Any]:
    return {"building_id": building_id, "ts": stamp(hours_ago), "kw": kw}


def post(client: TestClient, readings: list[dict[str, Any]], key: str = "batch-00000001", **headers: str):
    return client.post("/readings:batch", json={"readings": readings}, headers={"Idempotency-Key": key, **headers})


def count(session: Session, model: type) -> int:
    session.expire_all()
    return session.scalar(select(func.count()).select_from(model)) or 0


@pytest.fixture
def two_ids(seeded: Session) -> tuple[int, int]:
    first, second = seeded.scalars(select(Building.id).order_by(Building.id).limit(2))
    return first, second


# ---------------------------------------------------------------- auth


def test_no_key_is_refused(client: TestClient, two_ids: tuple[int, int]) -> None:
    assert post(client, [reading(two_ids[0], 1, 10)]).status_code == 401


def test_a_wrong_key_is_refused(client: TestClient, two_ids: tuple[int, int]) -> None:
    response = post(client, [reading(two_ids[0], 1, 10)], **{"X-API-Key": "not-the-key"})
    assert response.status_code == 401


def test_with_no_key_configured_ingestion_is_off_not_open(settings: Settings, two_ids: tuple[int, int]) -> None:
    app = create_app(settings.model_copy(update={"ingest_api_key": None}))
    with TestClient(app) as client:
        response = post(client, [reading(two_ids[0], 1, 10)], **{"X-API-Key": "anything"})
    assert response.status_code == 503


def test_refused_requests_write_nothing(client: TestClient, session: Session, two_ids: tuple[int, int]) -> None:
    post(client, [reading(two_ids[0], 1, 10)])
    assert count(session, Reading) == 0 and count(session, IngestBatch) == 0


# ---------------------------------------------------------------- the happy path


def test_ingests_and_reads_back_in_time_order(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]
) -> None:
    b1, _ = two_ids
    response = post(client, [reading(b1, 1, 300.5), reading(b1, 3, 100.0), reading(b1, 2, 200.25)], **auth)
    assert response.status_code == 200
    assert response.json() == {"idempotency_key": "batch-00000001", "accepted": 3, "duplicates": 0, "replayed": False}

    stored = client.get(f"/buildings/{b1}/readings").json()
    assert [r["kw"] for r in stored] == [100.0, 200.25, 300.5]
    assert stored == sorted(stored, key=lambda r: r["ts"])


def test_the_building_becomes_measured_once_it_has_readings(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]
) -> None:
    b1, b2 = two_ids
    assert client.get(f"/buildings/{b1}").json()["confidence"] == "modelled"
    post(client, [reading(b1, 1, 50)], **auth)
    measured, other = client.get(f"/buildings/{b1}").json(), client.get(f"/buildings/{b2}").json()
    assert measured["confidence"] == "measured" and measured["last_reading_at"] is not None
    assert other["confidence"] == "modelled" and other["last_reading_at"] is None


def test_one_meter_per_building_however_many_batches(
    client: TestClient, auth: dict[str, str], session: Session, two_ids: tuple[int, int]
) -> None:
    b1, b2 = two_ids
    post(client, [reading(b1, 1, 1), reading(b2, 1, 2)], key="batch-00000001", **auth)
    post(client, [reading(b1, 2, 3)], key="batch-00000002", **auth)
    assert count(session, Meter) == 2


def test_timestamps_with_other_offsets_are_stored_as_the_same_instant(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]
) -> None:
    b1, _ = two_ids
    instant = NOW - timedelta(hours=2)
    ist = instant.astimezone(timezone(timedelta(hours=5, minutes=30))).isoformat()
    post(client, [{"building_id": b1, "ts": ist, "kw": 42}], **auth)
    again = post(client, [{"building_id": b1, "ts": instant.isoformat(), "kw": 42}], key="batch-00000002", **auth)
    assert again.json()["duplicates"] == 1  # the same instant, written in a different offset


def test_a_window_can_be_read_back(client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]) -> None:
    b1, _ = two_ids
    post(client, [reading(b1, h, float(h)) for h in range(1, 7)], **auth)
    window = client.get(f"/buildings/{b1}/readings", params={"from": stamp(4), "to": stamp(2), "limit": 10}).json()
    assert [r["kw"] for r in window] == [4.0, 3.0]  # from is inclusive, to is exclusive
    assert len(client.get(f"/buildings/{b1}/readings", params={"limit": 2}).json()) == 2


def test_reading_for_an_unknown_building_is_a_404(client: TestClient) -> None:
    assert client.get("/buildings/999999/readings").status_code == 404


# ---------------------------------------------------------------- idempotency


def test_replaying_a_batch_writes_nothing_and_returns_the_original_counts(
    client: TestClient, auth: dict[str, str], session: Session, two_ids: tuple[int, int]
) -> None:
    b1, b2 = two_ids
    batch = [reading(b1, 1, 10), reading(b2, 1, 20), reading(b1, 2, 30)]
    first = post(client, batch, **auth).json()
    # The same batch in a different order is still the same batch.
    second = post(client, list(reversed(batch)), **auth).json()
    assert first["replayed"] is False and second["replayed"] is True
    assert (second["accepted"], second["duplicates"]) == (first["accepted"], first["duplicates"]) == (3, 0)
    assert count(session, Reading) == 3 and count(session, IngestBatch) == 1


def test_the_same_key_with_a_different_batch_is_a_conflict(
    client: TestClient, auth: dict[str, str], session: Session, two_ids: tuple[int, int]
) -> None:
    b1, _ = two_ids
    post(client, [reading(b1, 1, 10)], **auth)
    conflict = post(client, [reading(b1, 1, 11)], **auth)
    assert conflict.status_code == 409
    assert count(session, Reading) == 1  # the first batch stands


def test_an_existing_reading_is_a_duplicate_and_is_never_overwritten(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]
) -> None:
    b1, _ = two_ids
    post(client, [reading(b1, 1, 10), reading(b1, 2, 20)], key="batch-00000001", **auth)
    later = post(client, [reading(b1, 1, 999), reading(b1, 3, 30)], key="batch-00000002", **auth).json()
    assert (later["accepted"], later["duplicates"]) == (1, 1)
    values = {r["kw"] for r in client.get(f"/buildings/{b1}/readings").json()}
    assert values == {10.0, 20.0, 30.0}  # 999 was not written


def test_identical_repeats_inside_one_batch_count_as_duplicates(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]
) -> None:
    b1, _ = two_ids
    outcome = post(client, [reading(b1, 1, 10), reading(b1, 1, 10)], **auth).json()
    assert (outcome["accepted"], outcome["duplicates"]) == (1, 1)


@pytest.mark.parametrize("key", ["short", "has spaces in it!", "x" * 129, ""])
def test_a_bad_idempotency_key_is_refused(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int], key: str
) -> None:
    assert post(client, [reading(two_ids[0], 1, 10)], key=key, **auth).status_code == 422


def test_a_missing_idempotency_key_is_refused(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]
) -> None:
    response = client.post("/readings:batch", json={"readings": [reading(two_ids[0], 1, 10)]}, headers=auth)
    assert response.status_code == 422


# ---------------------------------------------------------------- validation and atomicity


def bad_cases(b1: int) -> list[tuple[str, dict[str, Any]]]:
    return [
        ("naive timestamp", {"building_id": b1, "ts": "2026-01-01T10:00:00", "kw": 5}),
        ("negative kw", {"building_id": b1, "ts": stamp(1), "kw": -1}),
        ("huge kw", {"building_id": b1, "ts": stamp(1), "kw": 1e9}),
        ("string kw", {"building_id": b1, "ts": stamp(1), "kw": "ten"}),
        ("zero building", {"building_id": 0, "ts": stamp(1), "kw": 5}),
        ("extra field", {"building_id": b1, "ts": stamp(1), "kw": 5, "note": "x"}),
        ("missing kw", {"building_id": b1, "ts": stamp(1)}),
        ("in the future", {"building_id": b1, "ts": (NOW + timedelta(days=2)).isoformat(), "kw": 5}),
        ("too old", {"building_id": b1, "ts": (NOW - timedelta(days=4000)).isoformat(), "kw": 5}),
    ]


def test_every_kind_of_bad_reading_is_refused(
    client: TestClient, auth: dict[str, str], session: Session, two_ids: tuple[int, int]
) -> None:
    for label, bad in bad_cases(two_ids[0]):
        response = post(client, [reading(two_ids[0], 5, 1), bad], **auth)
        assert response.status_code == 422, label
    assert count(session, Reading) == 0 and count(session, IngestBatch) == 0


def test_nan_and_infinity_are_refused(client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]) -> None:
    for token in ("NaN", "Infinity", "-Infinity"):
        body = f'{{"readings": [{{"building_id": {two_ids[0]}, "ts": "{stamp(1)}", "kw": {token}}}]}}'
        response = client.post(
            "/readings:batch",
            content=body,
            headers={"Idempotency-Key": "batch-00000001", "Content-Type": "application/json", **auth},
        )
        assert response.status_code == 422, token


def test_an_unknown_building_fails_the_whole_batch(
    client: TestClient, auth: dict[str, str], session: Session, two_ids: tuple[int, int]
) -> None:
    response = post(client, [reading(two_ids[0], 1, 10), reading(999_999, 1, 10)], **auth)
    assert response.status_code == 422 and "999999" in response.json()["detail"]
    assert count(session, Reading) == 0 and count(session, Meter) == 0


def test_conflicting_values_in_one_batch_fail_it_and_leave_the_key_unused(
    client: TestClient, auth: dict[str, str], session: Session, two_ids: tuple[int, int]
) -> None:
    b1, _ = two_ids
    bad = post(client, [reading(b1, 1, 10), reading(b1, 1, 11)], **auth)
    assert bad.status_code == 422
    assert count(session, Reading) == 0 and count(session, IngestBatch) == 0
    # Because nothing was consumed, the client can fix the batch and retry with the same key.
    retry = post(client, [reading(b1, 1, 10)], **auth)
    assert retry.status_code == 200 and retry.json()["accepted"] == 1


def test_the_empty_and_the_oversize_batch_are_refused(
    client: TestClient, auth: dict[str, str], two_ids: tuple[int, int]
) -> None:
    assert post(client, [], **auth).status_code == 422
    too_many = [reading(two_ids[0], 1, 1)] * 5001
    assert post(client, too_many, **auth).status_code == 422


def test_a_large_valid_batch_is_accepted(
    client: TestClient, auth: dict[str, str], session: Session, two_ids: tuple[int, int]
) -> None:
    """5,000 readings is the limit, and it crosses the insert chunk size twice."""
    b1, _ = two_ids
    batch = [{"building_id": b1, "ts": (NOW - timedelta(minutes=m)).isoformat(), "kw": float(m)} for m in range(5000)]
    response = post(client, batch, **auth)
    assert response.status_code == 200 and response.json()["accepted"] == 5000
    assert count(session, Reading) == 5000


def test_an_oversize_body_is_refused_before_it_is_read(settings: Settings, two_ids: tuple[int, int]) -> None:
    app = create_app(settings.model_copy(update={"max_body_bytes": 400}))
    with TestClient(app) as client:
        response = post(
            client,
            [reading(two_ids[0], h, 1.0) for h in range(1, 40)],
            **{"X-API-Key": settings.ingest_api_key.get_secret_value()},
        )  # type: ignore[union-attr]
    assert response.status_code == 413


def test_a_chunked_body_over_the_limit_is_refused_too(settings: Settings) -> None:
    """A client that does not declare a length cannot get round the limit."""
    app = create_app(settings.model_copy(update={"max_body_bytes": 400}))

    def chunks():
        for _ in range(10):
            yield b"x" * 100

    with TestClient(app) as client:
        response = client.post("/scenarios/simulate", content=chunks(), headers={"Content-Type": "application/json"})
    assert response.status_code == 413


# ---------------------------------------------------------------- races


def test_concurrent_requests_with_one_key_write_exactly_once(
    session: Session, engine_factory: sessionmaker[Session], two_ids: tuple[int, int]
) -> None:
    b1, b2 = two_ids
    batch = [ReadingIn(building_id=b, ts=NOW - timedelta(hours=h), kw=float(h)) for b in (b1, b2) for h in range(1, 21)]
    outcomes: list[Any] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(8)

    def worker() -> None:
        try:
            with engine_factory() as own:
                barrier.wait(timeout=10)
                outcomes.append(ingest_batch(own, key="race-key-00000001", readings=batch))
        except BaseException as exc:
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert not errors, errors
    assert len(outcomes) == 8
    assert sum(1 for o in outcomes if not o.replayed) == 1
    assert all(o.accepted == 40 and o.duplicates == 0 for o in outcomes)
    assert count(session, Reading) == 40 and count(session, IngestBatch) == 1 and count(session, Meter) == 2


def test_concurrent_batches_for_one_new_building_share_its_meter(
    session: Session, engine_factory: sessionmaker[Session], two_ids: tuple[int, int]
) -> None:
    """Different keys racing to create the same building's first meter must not fail or make two."""
    b1, _ = two_ids
    errors: list[BaseException] = []
    barrier = threading.Barrier(6)

    def worker(n: int) -> None:
        try:
            with engine_factory() as own:
                barrier.wait(timeout=10)
                ingest_batch(
                    own,
                    key=f"meter-race-{n:08d}",
                    readings=[ReadingIn(building_id=b1, ts=NOW - timedelta(hours=n + 1), kw=float(n))],
                )
        except BaseException as exc:
            errors.append(exc)

    threads: list[threading.Thread] = [threading.Thread(target=worker, args=(n,)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert not errors, errors
    assert count(session, Meter) == 1 and count(session, Reading) == 6
