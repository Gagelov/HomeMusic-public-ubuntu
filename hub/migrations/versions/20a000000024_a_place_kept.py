"""A place kept

A place in a playlist may be kept for a row of a transfer that has no track yet (app/playlists.py).

Revision ID: 20a000000024
Revises: 20a000000023
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000024"
down_revision = "20a000000023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "import_item_id" in {c["name"] for c in sa.inspect(op.get_bind()).get_columns("playlist_items")}:
        return
    with op.batch_alter_table("playlist_items") as t:
        t.alter_column("track_id", existing_type=sa.Integer(), nullable=True)
        t.add_column(sa.Column("import_item_id", sa.Integer(), nullable=True))
        t.create_foreign_key("fk_playlist_items_import_item", "import_items", ["import_item_id"], ["id"],
                             ondelete="CASCADE")
        t.create_index("ix_playlist_items_import_item_id", ["import_item_id"])


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
