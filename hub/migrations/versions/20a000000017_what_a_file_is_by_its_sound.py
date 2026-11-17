"""What a file is, settled by its sound

A file the catalog only has something like (another length, another version in its name) is filed under its own
names, and the record is kept with the search (`upgrades.meta_json`, `kind` "identify"): the record's file is
downloaded and the two are compared by their sound (app/library/upgrade.py).

Revision ID: 20a000000017
Revises: 20a000000016
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000017"
down_revision = "20a000000016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("upgrades", sa.Column("kind", sa.String(16), nullable=False, server_default="better"))
    op.add_column("upgrades", sa.Column("meta_json", sa.JSON(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
