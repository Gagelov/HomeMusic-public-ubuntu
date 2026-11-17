"""Artists with their spellings and projects, and the other names of a track

An artist has one name and other spellings; the library is written in the name (app/library/artists.py). Projects
of one person are linked, not joined. A track keeps the other names it is known by, for the search.

Revision ID: 20a000000019
Revises: 20a000000018
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000019"
down_revision = "20a000000018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "artists",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_table(
        "artist_names",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("artist_id", sa.Integer, sa.ForeignKey("artists.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("key", sa.String(300), nullable=False, unique=True),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index("ix_artist_names_artist_id", "artist_names", ["artist_id"])
    op.create_table(
        "artist_refs",
        sa.Column("ref", sa.String(64), primary_key=True),
        sa.Column("artist_id", sa.Integer, sa.ForeignKey("artists.id", ondelete="CASCADE"), nullable=False),
    )
    op.create_index("ix_artist_refs_artist_id", "artist_refs", ["artist_id"])
    for table in ("artist_links", "artist_apart"):
        op.create_table(
            table,
            sa.Column("low_id", sa.Integer, sa.ForeignKey("artists.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("high_id", sa.Integer, sa.ForeignKey("artists.id", ondelete="CASCADE"), primary_key=True),
        )
    op.create_table(
        "track_names",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("track_id", sa.Integer, sa.ForeignKey("tracks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(512), nullable=False),
        sa.Column("key", sa.String(512), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("track_id", "key", name="uq_track_names"),
    )
    op.create_index("ix_track_names_track_id", "track_names", ["track_id"])


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
