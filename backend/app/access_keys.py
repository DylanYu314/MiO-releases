"""Managed access keys and the import gate (ADR-009).

**A key gates; it does not own.** Ownership moved to `app/installs.py` in #170,
because answering both questions with the key meant every keyless user shared one
library and adding a key later hid everything imported before it. What is left
here is the key's real job: deciding whether search and import are allowed.

Keys are high-entropy capability tokens. We store only their SHA-256 hash, so a
database leak exposes nothing usable; the token itself is shown once at creation.
The gate is dormant until at least one active key exists, so a fresh install (and
the whole test suite) is never locked out.
"""

import hashlib
import secrets
from datetime import UTC, datetime

from fastapi import Depends, Header, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import AccessKey


def hash_key(raw: str) -> str:
    """SHA-256 hex of a token. Fast on purpose: the tokens are random and
    high-entropy, so there's no weak password to slow guessing on."""
    return hashlib.sha256(raw.encode()).hexdigest()


def create_access_key(db: Session, label: str, is_admin: bool = False) -> tuple[AccessKey, str]:
    """Mint a key. Returns the row and the plaintext token — the token is never
    recoverable afterwards, so the caller must surface it now.

    `is_admin` defaults to False and must be asked for explicitly: an admin key
    reads everyone's diagnostics, and that is not something to acquire by
    forgetting an argument."""
    raw = secrets.token_urlsafe(32)
    row = AccessKey(key_hash=hash_key(raw), label=label, is_admin=is_admin)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row, raw


def gate_active(db: Session) -> bool:
    """Whether the import gate is enforcing. True once any non-revoked key
    exists — or always, if `require_access_key` is set (a hosted deployment
    that should stay locked even before the first key). Otherwise revoking the
    last key opens the gate again (a recovery hatch)."""
    if get_settings().require_access_key:
        return True
    count = db.scalar(
        select(func.count()).select_from(AccessKey).where(AccessKey.revoked_at.is_(None))
    )
    return bool(count)


def is_valid_key(db: Session, raw: str) -> bool:
    """True if `raw` matches an active key. Read-only — used by the status
    check, which shouldn't count as "used"."""
    row = db.scalar(
        select(AccessKey).where(AccessKey.key_hash == hash_key(raw), AccessKey.revoked_at.is_(None))
    )
    return row is not None


def verify_access_key(db: Session, raw: str) -> bool:
    """True if `raw` matches an active key; records the use."""
    row = db.scalar(
        select(AccessKey).where(AccessKey.key_hash == hash_key(raw), AccessKey.revoked_at.is_(None))
    )
    if row is None:
        return False
    row.last_used_at = datetime.now(UTC)
    db.commit()
    return True


def resolve_key_id(db: Session, raw: str | None) -> int | None:
    """The id of the active key `raw` names, or None if there isn't one."""
    if not raw:
        return None
    row = db.scalar(
        select(AccessKey).where(AccessKey.key_hash == hash_key(raw), AccessKey.revoked_at.is_(None))
    )
    return row.id if row else None


def require_unlock_key(
    x_unlock_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> None:
    """Gate an import entrypoint. No-op while the gate is dormant; otherwise a
    valid `X-Unlock-Key` header is required (401 without one)."""
    if not gate_active(db):
        return
    if not x_unlock_key or not verify_access_key(db, x_unlock_key):
        raise HTTPException(status_code=401, detail="A valid access key is required to import")


def is_admin_key(db: Session, raw: str | None) -> bool:
    """Whether `raw` is an active key marked admin. Read-only, like
    `is_valid_key` — the status check should not count as a use."""
    if not raw:
        return False
    row = db.scalar(
        select(AccessKey).where(
            AccessKey.key_hash == hash_key(raw),
            AccessKey.revoked_at.is_(None),
            AccessKey.is_admin.is_(True),
        )
    )
    return row is not None


def require_admin_key(
    x_unlock_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> None:
    """Gate a developer-only view (#354).

    **Deliberately not `require_unlock_key` with an extra check, and deliberately
    not dormant.** The import gate is dormant until the first key exists, which
    is right for a feature that should work out of the box on a fresh install.
    This one guards other people's crash reports, so "no keys exist yet" must
    mean *closed*, not *open to all*.

    Same header, because admin is a superset and a second header would be a
    second thing for a client to get wrong.
    """
    if not x_unlock_key or not is_admin_key(db, x_unlock_key):
        raise HTTPException(status_code=403, detail="Administrator access required")
