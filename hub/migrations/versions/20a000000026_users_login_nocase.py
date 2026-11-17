"""Match Navidrome's case-insensitive login names in the Hub."""

import sqlalchemy as sa
from alembic import op

revision = "20a000000026"
down_revision = "20a000000025"
branch_labels = depends_on = None


def upgrade() -> None:
    op.create_index("uq_users_nd_username_nocase", "users", [sa.text("nd_username COLLATE NOCASE")],
                    unique=True, if_not_exists=True)


def downgrade() -> None:
    op.drop_index("uq_users_nd_username_nocase", table_name="users")
