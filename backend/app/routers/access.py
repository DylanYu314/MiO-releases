from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from app.access_keys import gate_active, is_admin_key, is_valid_key
from app.db import get_db
from app.schemas import AccessStatusRead

router = APIRouter(prefix="/access", tags=["access"])


@router.get("/status", response_model=AccessStatusRead)
def access_status(
    x_unlock_key: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> AccessStatusRead:
    """Let the UI show a lock instead of firing a doomed request: `locked` is
    whether the import gate is enforcing, `unlocked` whether this client's key
    gets through it (ADR-009).

    `admin` is a third, independent answer (#354): whether this key may read
    everyone's diagnostics. It is **not** implied by `unlocked` — every tester
    is unlocked and almost none are administrators — which is the distinction
    that makes the diagnostics page gate on this field rather than on that one.
    """
    locked = gate_active(db)
    unlocked = not locked or (x_unlock_key is not None and is_valid_key(db, x_unlock_key))
    return AccessStatusRead(locked=locked, unlocked=unlocked, admin=is_admin_key(db, x_unlock_key))
