"""A file is known by its sound

The picture Chromaprint draws of a file's sound (app/library/acoustic.py), kept with the file and with an upload: by
it an upload is told to be a recording the library has.

Revision ID: 20a000000015
Revises: 20a000000014
"""

import sqlalchemy as sa
from alembic import op

revision = "20a000000015"
down_revision = "20a000000014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("track_files", sa.Column("chroma", sa.LargeBinary(), nullable=True))
    op.add_column("uploads", sa.Column("chroma", sa.LargeBinary(), nullable=True))
    op.add_column("uploads", sa.Column("duration_s", sa.Float(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError("2.0 does not go back")
