"""A better sound for a weak file

What became of looking for a better file in the place of a weak one (app/library/upgrade.py): queued, being looked
for, found and waiting for the listener's word, put in the old file's place, nothing better, or declined.

Revision ID: 20a000000016
Revises: 20a000000015
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000016"
down_revision = "20a000000015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "upgrades",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("track_id", sa.Integer(), sa.ForeignKey("tracks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("item_id", sa.Integer(), sa.ForeignKey("download_items.id", ondelete="SET NULL"), nullable=True),
        sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("staged_path", sa.String(1024), nullable=True),
        sa.Column("codec", sa.String(16), nullable=True),
        sa.Column("bitrate_kbps", sa.Integer(), nullable=True),
        sa.Column("likeness", sa.Float(), nullable=True),
        sa.Column("provider", sa.String(32), nullable=True),
        sa.Column("source_url", sa.String(2048), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("was_codec", sa.String(16), nullable=True),
        sa.Column("was_kbps", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_upgrades_user_id", "upgrades", ["user_id"])
    op.create_index("ix_upgrades_track_id", "upgrades", ["track_id"])


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
