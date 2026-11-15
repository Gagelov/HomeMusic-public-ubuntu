"""How an artist looks

The round photo and the wide picture an artist is shown with, as the listeners chose them (app/library/looks.py).

Revision ID: 20a000000021
Revises: 20a000000020
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000021"
down_revision = "20a000000020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "artist_looks",
        sa.Column("artist_id", sa.Integer, sa.ForeignKey("artists.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("photo_choice", sa.String(80)),
        sa.Column("photo_image", sa.LargeBinary),
        sa.Column("photo_key", sa.String(16)),
        sa.Column("banner_choice", sa.String(320)),
        sa.Column("banner_image", sa.LargeBinary),
        sa.Column("banner_key", sa.String(16)),
        sa.Column("by", sa.Integer, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("at", sa.DateTime, nullable=False),
    )


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
