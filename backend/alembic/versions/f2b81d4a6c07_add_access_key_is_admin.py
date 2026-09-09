"""add access_key is_admin

An ordinary access key says "you may import". An admin key additionally says
"you may read everyone's diagnostics" — crash reports, and whatever each tester
typed into "what were you doing".

Additive and defaulted **false**, which is the whole safety property: every key
that existed before this migration was handed to a tester, and none of them
should become an administrator by being old.

Revision ID: f2b81d4a6c07
Revises: e93a5c2b71f8
Create Date: 2026-08-06

"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "f2b81d4a6c07"
down_revision: Union[str, Sequence[str], None] = "e93a5c2b71f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "access_keys",
        # Server default as well as NOT NULL: SQLite cannot add a NOT NULL
        # column to a populated table without one, and "0" is what makes every
        # pre-existing key an ordinary key rather than an admin one.
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("access_keys", "is_admin")
