"""initial schema: campuses, buildings, meters, readings and the idempotency ledger

Revision ID: 0001
Revises:
Create Date: 2026-10-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "campuses",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("timezone", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_campuses")),
    )
    op.create_table(
        "ingest_batches",
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("payload_sha256", sa.String(length=64), nullable=False),
        sa.Column("reading_count", sa.Integer(), nullable=False),
        sa.Column("accepted", sa.Integer(), nullable=False),
        sa.Column("duplicates", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("idempotency_key", name=op.f("pk_ingest_batches")),
    )
    op.create_table(
        "neighbourhoods",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("campus_id", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.ForeignKeyConstraint(
            ["campus_id"], ["campuses.id"], name=op.f("fk_neighbourhoods_campus_id_campuses"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_neighbourhoods")),
        sa.UniqueConstraint("campus_id", "name", name=op.f("uq_neighbourhoods_campus_id")),
    )
    op.create_table(
        "buildings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("ref", sa.String(length=160), nullable=False),
        sa.Column("campus_id", sa.String(length=32), nullable=False),
        sa.Column("neighbourhood_id", sa.Integer(), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("archetype", sa.String(length=32), nullable=False),
        sa.Column("x_m", sa.Double(), nullable=False),
        sa.Column("z_m", sa.Double(), nullable=False),
        sa.Column("width_m", sa.Double(), nullable=False),
        sa.Column("depth_m", sa.Double(), nullable=False),
        sa.Column("height_m", sa.Double(), nullable=False),
        sa.Column("floors", sa.Integer(), nullable=False),
        sa.Column("footprint_m2", sa.Double(), nullable=False),
        sa.Column("solar_kwp", sa.Double(), nullable=False),
        sa.Column("outline", sa.JSON().with_variant(postgresql.JSONB(), "postgresql"), nullable=True),
        sa.Column("position_source", sa.String(length=24), nullable=False),
        sa.Column("calibration", sa.Double(), nullable=False),
        sa.Column("rev", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "position_source IN ('osm_footprint', 'osm_point', 'inferred', 'placeholder')",
            name=op.f("ck_buildings_position_source_known"),
        ),
        sa.CheckConstraint("calibration > 0", name=op.f("ck_buildings_calibration_positive")),
        sa.CheckConstraint("floors >= 1", name=op.f("ck_buildings_floors_positive")),
        sa.CheckConstraint("footprint_m2 > 0", name=op.f("ck_buildings_footprint_positive")),
        sa.CheckConstraint("rev >= 1", name=op.f("ck_buildings_rev_positive")),
        sa.CheckConstraint("solar_kwp >= 0", name=op.f("ck_buildings_solar_not_negative")),
        sa.CheckConstraint("width_m > 0 AND depth_m > 0 AND height_m > 0", name=op.f("ck_buildings_size_positive")),
        sa.ForeignKeyConstraint(
            ["campus_id"], ["campuses.id"], name=op.f("fk_buildings_campus_id_campuses"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["neighbourhood_id"],
            ["neighbourhoods.id"],
            name=op.f("fk_buildings_neighbourhood_id_neighbourhoods"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_buildings")),
        sa.UniqueConstraint("ref", name=op.f("uq_buildings_ref")),
    )
    op.create_index("ix_buildings_campus_id", "buildings", ["campus_id"], unique=False)
    op.create_table(
        "meters",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("building_id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("unit", sa.String(length=8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('measured', 'modelled')", name=op.f("ck_meters_kind_known")),
        sa.ForeignKeyConstraint(
            ["building_id"], ["buildings.id"], name=op.f("fk_meters_building_id_buildings"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_meters")),
        sa.UniqueConstraint("building_id", "kind", name=op.f("uq_meters_building_id")),
    )
    op.create_table(
        "readings",
        sa.Column("meter_id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("value_kw", sa.Double(), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("batch_key", sa.String(length=128), nullable=True),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("value_kw >= 0", name=op.f("ck_readings_value_not_negative")),
        sa.ForeignKeyConstraint(
            ["batch_key"],
            ["ingest_batches.idempotency_key"],
            name=op.f("fk_readings_batch_key_ingest_batches"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["meter_id"], ["meters.id"], name=op.f("fk_readings_meter_id_meters"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("meter_id", "ts", name=op.f("pk_readings")),
    )


def downgrade() -> None:
    op.drop_table("readings")
    op.drop_table("meters")
    op.drop_index("ix_buildings_campus_id", table_name="buildings")
    op.drop_table("buildings")
    op.drop_table("neighbourhoods")
    op.drop_table("ingest_batches")
    op.drop_table("campuses")
