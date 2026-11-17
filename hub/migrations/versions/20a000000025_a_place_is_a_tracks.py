"""A place is a track's

A row of a transfer the catalog does not know is a track of the Hub, known by its name alone (app/library/tracks.py
`by_name`): a playlist needs no place without a track. The places kept so (20a000000024) go — the transfer puts the
tracks there when it settles its playlists next.

Revision ID: 20a000000025
Revises: 20a000000024
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000025"
down_revision = "20a000000024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "import_item_id" not in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("playlist_items")}:
        return
    op.execute("DELETE FROM playlist_items WHERE track_id IS NULL")
    with op.batch_alter_table("playlist_items") as t:
        t.drop_index("ix_playlist_items_import_item_id")
        t.drop_constraint("fk_playlist_items_import_item", type_="foreignkey")
        t.drop_column("import_item_id")
        t.alter_column("track_id", existing_type=sa.Integer(), nullable=False)


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
