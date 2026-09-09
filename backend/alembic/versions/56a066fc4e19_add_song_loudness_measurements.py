"""add song loudness measurements

Revision ID: 56a066fc4e19
Revises: b7d2e5a91c33
Create Date: 2026-07-25 04:42:27.605185

Two nullable columns for the EBU R128 measurements taken at import
(app/loudness.py). Nullable rather than defaulted: every existing row genuinely
has no measurement, and a silent file legitimately has none either. Playback
falls back to no correction, and scripts/analyze_loudness.py backfills.

Autogenerate also proposed re-typing `playlists.kind` from VARCHAR(20) to the
non-native Enum. That has been removed deliberately. The column already holds
the right values; the diff is only that SQLAlchemy renders the type
differently, and SQLite would rebuild the whole table to apply it. Rewriting an
enum column is exactly what broke every pre-existing playlist once already
(b7d2e5a91c33 was the repair) — it stores the enum NAME, so a rebuild that
round-trips through the wrong casing makes rows unreadable at runtime. Not
worth the risk for a cosmetic type change.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "56a066fc4e19"
down_revision: Union[str, Sequence[str], None] = "b7d2e5a91c33"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("songs", sa.Column("loudness_lufs", sa.Float(), nullable=True))
    op.add_column("songs", sa.Column("peak_dbfs", sa.Float(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("songs", "peak_dbfs")
    op.drop_column("songs", "loudness_lufs")
