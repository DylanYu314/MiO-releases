"""Who owns a library — which is not the same question as who may import (#170).

P12 answered both with the access key, because when it was written the key was
the only per-user handle that existed. That conflated two unrelated things, and
broke in the flow a real tester follows:

- a keyless user's rows were owned by nobody, so **every** keyless user shared one
  library and they saw each other's music;
- adding a key later re-scoped every read, so everything imported before the key
  arrived became invisible — the library looked wiped.

Ownership now belongs to an **install**: a random token the client mints on first
launch, keeps, and presents as `X-Install-Id`. The access key is left with its one
real job, gating search and import (ADR-009).

The token is minted by the *client*, not issued by the server, so a first request
needs no handshake — an install registers itself the first time it is seen. That
makes the identity unauthenticated by construction: anyone who learns a token owns
that library. It is an anonymous identity, not an account, and the same trade
localStorage-based identity makes everywhere. Phase 6's auth is what replaces it.
"""

import hashlib
from datetime import UTC, datetime

from fastapi import Depends, Header, HTTPException
from sqlalchemy import false, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Install

# Long enough that guessing another install's token is not a strategy, and short
# enough to sit in a header comfortably.
MIN_TOKEN_LENGTH = 16


def hash_token(raw: str) -> str:
    """SHA-256 hex of an install token. Fast on purpose: the tokens are random
    and high-entropy, so there is no weak password to slow guessing on."""
    return hashlib.sha256(raw.encode()).hexdigest()


def resolve_install_id(db: Session, raw: str | None, *, create: bool) -> int | None:
    """The install id for a token, registering it on first sight when asked.

    `create` is what distinguishes a write from a read. A *write* registers the
    install, because that is the request establishing ownership. A *read* does
    not: an unknown token then resolves to `None` and sees nothing, rather than
    silently creating a row for every stray or malformed header that arrives.
    """
    if not raw or len(raw) < MIN_TOKEN_LENGTH:
        return None

    token_hash = hash_token(raw)
    install = db.scalar(select(Install).where(Install.token_hash == token_hash))

    if install is None:
        if not create:
            return None
        install = Install(token_hash=token_hash)
        db.add(install)
        db.commit()
        db.refresh(install)

    install.last_seen_at = datetime.now(UTC)
    db.commit()
    return install.id


def current_owner(
    x_install_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> int | None:
    """The install whose rows this request may see. Read-only: never registers.

    Returns `None` for a missing, malformed or unrecognised token — and `owned_by`
    turns that into "no rows at all". So an unknown id sees an empty library
    rather than inheriting whatever nobody owns, which is what P12 got wrong.
    """
    return resolve_install_id(db, x_install_id, create=False)


def owned_by(model: type, owner_install_id: int | None):
    """A WHERE clause restricting `model` to rows this install owns.

    Written once and reused by every read path: an isolation boundary is only as
    strong as the endpoint that forgets it, so there should be exactly one
    expression of the rule.

    **`None` means "no rows", not "the rows nobody owns".** That is the whole
    difference from P12, where no-key mapped to `IS NULL` and every keyless caller
    shared that set. Rows owned by nobody — everything predating #170 — are now
    visible to no request at all, and an unrecognised install id sees nothing
    rather than inheriting a stranger's leftovers.
    """
    if owner_install_id is None:
        return false()
    return model.owner_install_id == owner_install_id


def require_install(
    x_install_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> int:
    """The install to record as the owner of something being created, refusing the
    request if there isn't one.

    Registers on first sight, so a brand-new client's very first import
    establishes its library with no separate sign-up step.

    It *refuses* rather than tolerating a missing header because the alternative
    is worse than an error: a row owned by nobody is now visible to nobody, so a
    client that forgot to identify itself would silently import into a black hole.
    A 400 is a bug someone can find.
    """
    install_id = resolve_install_id(db, x_install_id, create=True)
    if install_id is None:
        raise HTTPException(
            status_code=400,
            detail="A client identifier is required to create anything (X-Install-Id).",
        )
    return install_id
