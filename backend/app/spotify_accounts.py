"""Spotify account persistence: token storage and silent refresh.

Kept separate from app/spotify.py so the HTTP wrapper stays free of DB
concerns, the same way app/jobs.py sits between the routers and the tool
wrappers.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SpotifyAccount
from app.spotify import SpotifyUser, TokenSet, refresh_token_set

# Refresh this long before the token actually expires, so a token that's
# valid now can't expire mid-request.
TOKEN_REFRESH_SKEW = timedelta(seconds=60)


def upsert_account(db: Session, tokens: TokenSet, user: SpotifyUser) -> SpotifyAccount:
    """Store a fresh login, updating the existing row if this Spotify user
    has connected before (reconnecting must never duplicate an account)."""
    account = db.scalar(select(SpotifyAccount).where(SpotifyAccount.spotify_user_id == user.id))
    if account is None:
        account = SpotifyAccount(spotify_user_id=user.id)
        db.add(account)
    account.display_name = user.display_name
    account.access_token = tokens.access_token
    account.refresh_token = tokens.refresh_token
    account.token_expires_at = tokens.expires_at
    account.scopes = tokens.scopes
    db.commit()
    db.refresh(account)
    return account


def get_fresh_access_token(db: Session, account: SpotifyAccount, client_id: str) -> str:
    """Return a usable access token, refreshing (and persisting) a stale one.

    Raises SpotifyAuthError via the refresh call when the authorization is
    gone for good (user revoked access, or the dev-mode app stopped working).
    """
    expires_at = account.token_expires_at
    if expires_at.tzinfo is None:
        # SQLite hands timestamps back naive; they were stored as UTC.
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at - TOKEN_REFRESH_SKEW > datetime.now(UTC):
        return account.access_token

    tokens = refresh_token_set(client_id, account.refresh_token)
    account.access_token = tokens.access_token
    account.refresh_token = tokens.refresh_token
    account.token_expires_at = tokens.expires_at
    db.commit()
    return tokens.access_token
