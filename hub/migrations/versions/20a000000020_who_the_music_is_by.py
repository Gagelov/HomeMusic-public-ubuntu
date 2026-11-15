"""Who the music is by

A track and an album name their artists by links (`track_artists`, `album_artists`), not by the letters of a line:
namesakes stay apart, and an artist's new name rewrites exactly their music. When a catalog's record was tied to an
artist is kept (`artist_refs.tied_at`): the first is their own, a later one a listener joined.

Revision ID: 20a000000020
Revises: 20a000000019
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000020"
down_revision = "20a000000019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite runs each statement by itself: a run that stopped half way leaves what it made, so each is asked for
    have = sa.inspect(op.get_bind())
    for table, owner, owners in (("track_artists", "track_id", "tracks"), ("album_artists", "album_id", "albums")):
        if have.has_table(table):
            continue
        op.create_table(
            table,
            sa.Column(owner, sa.Integer, sa.ForeignKey(f"{owners}.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("position", sa.Integer, primary_key=True),
            sa.Column("artist_id", sa.Integer, sa.ForeignKey("artists.id", ondelete="CASCADE"), nullable=False),
        )
        op.create_index(f"ix_{table}_artist_id", table, ["artist_id"])
    if "tied_at" not in {c["name"] for c in have.get_columns("artist_refs")}:
        # the records tied before this was kept are the oldest (a column added to a table takes a constant only)
        op.add_column("artist_refs", sa.Column("tied_at", sa.DateTime, nullable=False, server_default=sa.text("'2026-01-01 00:00:00'")))


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
