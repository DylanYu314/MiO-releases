"""normalise playlist kind casing

The first revision of a3f1c9d7e204 back-filled the enum's *value* ("user")
where SQLAlchemy reads its *name* ("USER"), so any database that ran that
version has pre-existing playlists it can no longer load. This repairs them.

Idempotent, and a no-op on databases seeded after the fix.

Revision ID: b7d2e5a91c33
Revises: a3f1c9d7e204
Create Date: 2026-07-25

"""

from collections.abc import Sequence
from typing import Union

from alembic import op

revision: str = "b7d2e5a91c33"
down_revision: Union[str, Sequence[str], None] = "a3f1c9d7e204"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("UPDATE playlists SET kind = upper(kind) WHERE kind <> upper(kind)")


def downgrade() -> None:
    # Nothing to undo: the corrected casing is what every other enum column
    # already uses, and lower-casing it again would only reintroduce the bug.
    pass
