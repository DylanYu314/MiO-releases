"""add client_error level and client_key

The table stopped being crashes-only in #322: the phone now keeps a rolling log
and uploads it once a day, so the same rows carry an import that failed or a
request that never came back alongside the crashes.

Two columns, both additive:

- `level` is NOT NULL with a server default, which is what lets SQLite add it to
  a table that already has rows — and the default is `error`, so every row
  written before this migration reads as exactly what it was.
- `client_key` is nullable and UNIQUE, so a re-sent batch cannot store the same
  entry twice. Nullable matters: SQLite's UNIQUE does not constrain NULLs, so
  the crash path — which mints no key — can keep writing as many rows as it
  likes.

Revision ID: e93a5c2b71f8
Revises: d1f145b13692
Create Date: 2026-08-06

"""

from collections.abc import Sequence
from typing import Union

import sqlalchemy as sa
from alembic import op

revision: str = "e93a5c2b71f8"
down_revision: Union[str, Sequence[str], None] = "d1f145b13692"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "client_errors",
        sa.Column("level", sa.String(length=16), nullable=False, server_default="error"),
    )
    op.add_column(
        "client_errors",
        sa.Column("client_key", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_client_errors_client_key",
        "client_errors",
        ["client_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_client_errors_client_key", table_name="client_errors")
    op.drop_column("client_errors", "client_key")
    op.drop_column("client_errors", "level")
