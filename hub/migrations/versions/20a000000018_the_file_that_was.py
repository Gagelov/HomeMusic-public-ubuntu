"""The file a better one took the place of

Where the old file lies in the trash folder (`upgrades.was_path`): while it is kept there the listener can hear the
two side by side and take the old one back (app/library/upgrade.py `revert`).

Revision ID: 20a000000018
Revises: 20a000000017
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000018"
down_revision = "20a000000017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("upgrades", sa.Column("was_path", sa.String(1024), nullable=True))


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
