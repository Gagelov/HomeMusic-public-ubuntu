"""Who made the beat

A track's producer, taken out of its name where the name carried it (app/library/titles.py).

Revision ID: 20a000000023
Revises: 20a000000022
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000023"
down_revision = "20a000000022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "producer" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("tracks")}:
        op.add_column("tracks", sa.Column("producer", sa.String(300), nullable=True))


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
