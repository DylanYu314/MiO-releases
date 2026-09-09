"""add playlist kind

Revision ID: a3f1c9d7e204
Revises: 5bc650e3ca39
Create Date: 2026-07-24

"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa

from alembic import op

revision: str = "a3f1c9d7e204"
down_revision: Union[str, Sequence[str], None] = "5bc650e3ca39"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SQLAlchemy's Enum(..., native_enum=False) stores the enum *name*, not its
    # value — every other status column in this schema holds 'QUEUED', 'DONE'
    # and so on. Back-filling 'user' here instead of 'USER' makes existing rows
    # unreadable ("'user' is not among the defined enum values").
    #
    # Existing playlists are all user-made; the favourites row is created on
    # first use rather than seeded here, so an untouched library stays clean.
    op.add_column(
        "playlists",
        sa.Column("kind", sa.String(length=20), nullable=False, server_default="USER"),
    )


def downgrade() -> None:
    op.drop_column("playlists", "kind")
