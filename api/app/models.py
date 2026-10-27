"""The database schema.

One table per thing in the plan's data model that this service needs today: campuses, neighbourhoods,
buildings, meters, readings and the idempotency ledger. Users, actions and verified savings come later.
Campus id is the tenant key; every building belongs to exactly one campus.
"""

from __future__ import annotations

from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy import CheckConstraint, ForeignKey, Index, MetaData, UniqueConstraint
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Stable constraint names, so migrations are reproducible and diffs are readable.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

# Plain JSON on SQLite (tests), binary JSON on Postgres.
JSONType = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")

POSITION_SOURCES = ("osm_footprint", "osm_point", "inferred", "placeholder")
METER_KINDS = ("measured", "modelled")


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(sa.types.TypeDecorator[datetime]):
    """A timestamp that is always timezone-aware UTC in Python, on every database.

    Naive values are refused on the way in, so a local time can never be stored by accident. SQLite has no
    timezone type and hands back naive values; those are read as UTC.
    """

    impl = sa.DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: sa.Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("timestamps must be timezone-aware")
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect: sa.Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Campus(Base):
    __tablename__ = "campuses"

    id: Mapped[str] = mapped_column(sa.String(32), primary_key=True)
    name: Mapped[str] = mapped_column(sa.String(120))
    timezone: Mapped[str] = mapped_column(sa.String(64), default="Asia/Kolkata")


class Neighbourhood(Base):
    """A group of buildings that ranks together: a set of hostels, a teaching complex."""

    __tablename__ = "neighbourhoods"
    __table_args__ = (UniqueConstraint("campus_id", "name"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    campus_id: Mapped[str] = mapped_column(ForeignKey("campuses.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(sa.String(80))


class Building(Base):
    __tablename__ = "buildings"
    __table_args__ = (
        Index("ix_buildings_campus_id", "campus_id"),
        CheckConstraint("width_m > 0 AND depth_m > 0 AND height_m > 0", name="size_positive"),
        CheckConstraint("floors >= 1", name="floors_positive"),
        CheckConstraint("footprint_m2 > 0", name="footprint_positive"),
        CheckConstraint("calibration > 0", name="calibration_positive"),
        CheckConstraint("solar_kwp >= 0", name="solar_not_negative"),
        CheckConstraint("rev >= 1", name="rev_positive"),
        CheckConstraint(
            "position_source IN (" + ", ".join(f"'{s}'" for s in POSITION_SOURCES) + ")",
            name="position_source_known",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # A stable name for seeding: campus, a slug of the name, and which one when names repeat.
    ref: Mapped[str] = mapped_column(sa.String(160), unique=True)
    campus_id: Mapped[str] = mapped_column(ForeignKey("campuses.id", ondelete="CASCADE"))
    neighbourhood_id: Mapped[int | None] = mapped_column(
        ForeignKey("neighbourhoods.id", ondelete="SET NULL"), default=None
    )
    name: Mapped[str] = mapped_column(sa.String(120))
    archetype: Mapped[str] = mapped_column(sa.String(32))

    # Metres east and south of the scene origin, as the front end draws them.
    x_m: Mapped[float] = mapped_column(sa.Double)
    z_m: Mapped[float] = mapped_column(sa.Double)
    width_m: Mapped[float] = mapped_column(sa.Double)
    depth_m: Mapped[float] = mapped_column(sa.Double)
    height_m: Mapped[float] = mapped_column(sa.Double)
    floors: Mapped[int]
    footprint_m2: Mapped[float] = mapped_column(sa.Double)
    solar_kwp: Mapped[float] = mapped_column(sa.Double, default=0.0)
    outline: Mapped[list[list[float]] | None] = mapped_column(JSONType, default=None)
    position_source: Mapped[str] = mapped_column(sa.String(24))

    calibration: Mapped[float] = mapped_column(sa.Double, default=1.0)
    # Bumped on any change, so caches that depend on this building know to recompute it.
    rev: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class Meter(Base):
    """Where readings for a building come from. Only measured meters exist so far."""

    __tablename__ = "meters"
    __table_args__ = (
        UniqueConstraint("building_id", "kind"),
        CheckConstraint("kind IN (" + ", ".join(f"'{k}'" for k in METER_KINDS) + ")", name="kind_known"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    building_id: Mapped[int] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(sa.String(16))
    unit: Mapped[str] = mapped_column(sa.String(8), default="kW")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class IngestBatch(Base):
    """The idempotency ledger: one row per accepted Idempotency-Key.

    A retry with the same key and the same payload gets the original counts back and writes nothing. The same
    key with a different payload is refused. A batch that fails leaves no row, so it can be retried safely.
    """

    __tablename__ = "ingest_batches"

    idempotency_key: Mapped[str] = mapped_column(sa.String(128), primary_key=True)
    payload_sha256: Mapped[str] = mapped_column(sa.String(64))
    reading_count: Mapped[int]
    accepted: Mapped[int] = mapped_column(default=0)
    duplicates: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Reading(Base):
    """Average power, in kW, at one instant for one meter. Immutable once written.

    Unique on (meter, time), so replaying a reading cannot count it twice. The plan partitions this table by
    month once it grows; today it is a plain table.
    """

    __tablename__ = "readings"
    __table_args__ = (CheckConstraint("value_kw >= 0", name="value_not_negative"),)

    meter_id: Mapped[int] = mapped_column(
        ForeignKey("meters.id", ondelete="CASCADE"), primary_key=True, autoincrement=False
    )
    ts: Mapped[datetime] = mapped_column(UTCDateTime, primary_key=True)
    value_kw: Mapped[float] = mapped_column(sa.Double)
    source: Mapped[str] = mapped_column(sa.String(32), default="api")
    batch_key: Mapped[str | None] = mapped_column(
        ForeignKey("ingest_batches.idempotency_key", ondelete="SET NULL"), default=None
    )
    received_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
