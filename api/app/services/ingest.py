"""Reading ingestion: validated, atomic and idempotent.

Guarantees, in the order a client cares about them:

* A batch is all or nothing. If any reading is wrong, none are written and the key is not consumed.
* Sending the same batch twice with the same Idempotency-Key writes nothing the second time and returns the
  original counts. A client can retry after a timeout without double counting.
* Re-using a key for a different batch is refused (409), never silently merged.
* A reading is unique per meter and instant. One that already exists is counted as a duplicate and left
  untouched, so stored readings are immutable. Corrections need a separate, explicit route.
* Two requests racing on the same key cannot both write: the key is claimed first, as a primary key insert.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Building, IngestBatch, Meter, Reading, utcnow
from app.schemas import ReadingIn

MAX_AGE = timedelta(days=3650)
MAX_FUTURE = timedelta(minutes=5)  # clock skew allowance
INSERT_CHUNK = 1_000


class IngestError(Exception):
    """Base for refusals that the API turns into a 4xx."""


class UnknownBuildings(IngestError):
    def __init__(self, ids: Sequence[int]) -> None:
        self.ids = sorted(ids)
        super().__init__(f"unknown building ids: {self.ids[:20]}")


class BadTimestamps(IngestError):
    pass


class ConflictingReadings(IngestError):
    pass


class IdempotencyConflict(IngestError):
    pass


@dataclass(frozen=True)
class IngestOutcome:
    accepted: int
    duplicates: int
    replayed: bool


Normalised = tuple[int, datetime, float]


def _normalise(readings: Sequence[ReadingIn], now: datetime) -> list[Normalised]:
    """To UTC, range-checked, identical repeats inside the batch collapsed."""
    oldest, newest = now - MAX_AGE, now + MAX_FUTURE
    seen: dict[tuple[int, datetime], float] = {}
    for r in readings:
        ts = r.ts.astimezone(UTC)
        if not oldest <= ts <= newest:
            raise BadTimestamps(f"timestamp outside the accepted range: {ts.isoformat()}")
        key = (r.building_id, ts)
        if key in seen:
            if seen[key] != r.kw:
                raise ConflictingReadings(
                    f"building {r.building_id} has two different values at {ts.isoformat()} in one batch"
                )
            continue
        seen[key] = r.kw
    return [(b, ts, kw) for (b, ts), kw in seen.items()]


def payload_hash(readings: Sequence[Normalised]) -> str:
    """Order-independent fingerprint of a batch, so a retry in a different order is still the same batch."""
    canonical = sorted((b, ts.isoformat(), repr(kw)) for b, ts, kw in readings)
    return hashlib.sha256(json.dumps(canonical, separators=(",", ":")).encode()).hexdigest()


def _insert_for(session: Session) -> Callable[..., postgresql.Insert | sqlite.Insert]:
    name = session.get_bind().dialect.name
    if name == "postgresql":
        return postgresql.insert
    if name == "sqlite":
        return sqlite.insert
    raise RuntimeError(f"unsupported database dialect: {name}")


def _ensure_meters(session: Session, building_ids: set[int]) -> dict[int, int]:
    """The measured meter of each building, created on first use. Safe against a concurrent creator."""
    insert_stmt = _insert_for(session)
    session.execute(
        insert_stmt(Meter)
        .values([{"building_id": b, "kind": "measured", "unit": "kW", "created_at": utcnow()} for b in building_ids])
        .on_conflict_do_nothing(index_elements=["building_id", "kind"])
    )
    rows = session.execute(
        select(Meter.building_id, Meter.id).where(Meter.kind == "measured", Meter.building_id.in_(building_ids))
    )
    return {building_id: meter_id for building_id, meter_id in rows}


def _chunks(items: Sequence[Normalised], size: int) -> Iterator[Sequence[Normalised]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def ingest_batch(
    session: Session,
    *,
    key: str,
    readings: Sequence[ReadingIn],
    now: datetime | None = None,
) -> IngestOutcome:
    """Write one batch. Commits on success and rolls back on any failure."""
    now = now or utcnow()
    unique = _normalise(readings, now)
    fingerprint = payload_hash(unique)

    building_ids = {b for b, _, _ in unique}
    found = set(session.scalars(select(Building.id).where(Building.id.in_(building_ids))))
    if found != building_ids:
        raise UnknownBuildings(sorted(building_ids - found))

    # Claim the key before writing anything. The primary key makes a concurrent request with the same key wait
    # for this transaction, then fail here and be answered from the ledger.
    batch = IngestBatch(idempotency_key=key, payload_sha256=fingerprint, reading_count=len(readings))
    try:
        session.add(batch)
        session.flush()
    except IntegrityError:
        session.rollback()
        prior = session.get(IngestBatch, key)
        if prior is None:
            raise
        if prior.payload_sha256 != fingerprint:
            raise IdempotencyConflict("this Idempotency-Key was already used for a different batch") from None
        return IngestOutcome(prior.accepted, prior.duplicates, replayed=True)

    try:
        meter_ids = _ensure_meters(session, building_ids)
        insert_stmt = _insert_for(session)
        accepted = 0
        for chunk in _chunks(unique, INSERT_CHUNK):
            inserted = session.execute(
                insert_stmt(Reading)
                .values(
                    [
                        {
                            "meter_id": meter_ids[b],
                            "ts": ts,
                            "value_kw": kw,
                            "source": "api",
                            "batch_key": key,
                            "received_at": now,
                        }
                        for b, ts, kw in chunk
                    ]
                )
                .on_conflict_do_nothing(index_elements=["meter_id", "ts"])
                .returning(Reading.meter_id)
            )
            accepted += len(inserted.all())
        batch.accepted = accepted
        batch.duplicates = len(readings) - accepted
        session.commit()
    except BaseException:
        session.rollback()
        raise
    return IngestOutcome(accepted, len(readings) - accepted, replayed=False)
