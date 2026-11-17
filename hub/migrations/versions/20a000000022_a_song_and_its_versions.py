"""A song and its versions

Tracks that are recordings of one song are its versions (app/library/versions.py): each a track of its own, tied
by the song, one of them the preferred.

Revision ID: 20a000000022
Revises: 20a000000021
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000022"
down_revision = "20a000000021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite runs each statement by itself: a run that stopped half way leaves what it made, so each is asked for
    have = sa.inspect(op.get_bind())
    if not have.has_table("songs"):
        op.create_table(
            "songs",
            sa.Column("id", sa.Integer, primary_key=True),
            sa.Column("preferred_track_id", sa.Integer),
            sa.Column("created_at", sa.DateTime, nullable=False),
        )
    if not have.has_table("song_tracks"):
        op.create_table(
            "song_tracks",
            sa.Column("track_id", sa.Integer, sa.ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("song_id", sa.Integer, sa.ForeignKey("songs.id", ondelete="CASCADE"), nullable=False),
            sa.Column("label", sa.String(64)),
            sa.Column("joined_at", sa.DateTime, nullable=False),
        )
        op.create_index("ix_song_tracks_song_id", "song_tracks", ["song_id"])


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
