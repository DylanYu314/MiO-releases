"""Google account persistence: token storage and silent refresh (#106).

Kept separate from app/google.py so the HTTP wrapper stays free of DB concerns,
the same split app/spotify_accounts.py has from app/spotify.py.

The single-account shape is deliberate: MiO imports from *your* YouTube
playlists, and there is exactly one of you. `get_account` returns the connected
one or nothing, so callers never have to decide which.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.google import GoogleChannel, TokenSet, refresh_token_set
from app.models import GoogleAccount

# Refresh this long before the token actually expires, so a token that is valid
# when checked cannot expire mid-request.
TOKEN_REFRESH_SKEW = timedelta(seconds=60)


def get_account(db: Session) -> GoogleAccount | None:
    """The connected account, or None.

    Newest first, so a reconnection that somehow produced a second row is not
    resolved by returning the stale one.
    """
    return db.scalars(select(GoogleAccount).order_by(GoogleAccount.created_at.desc())).first()


def upsert_account(db: Session, tokens: TokenSet, channel: GoogleChannel) -> GoogleAccount:
    """Store a fresh login, updating the row if this channel has connected before.

    Keyed on the channel id so reconnecting — which happens **every seven days**
    while the consent screen is in Testing — updates one row instead of piling
    up a new account each week.
    """
    account = db.scalar(select(GoogleAccount).where(GoogleAccount.channel_id == channel.id))
    if account is None:
        account = GoogleAccount(channel_id=channel.id)
        db.add(account)
    account.channel_title = channel.title
    account.access_token = tokens.access_token
    account.refresh_token = tokens.refresh_token
    account.token_expires_at = tokens.expires_at
    account.scopes = tokens.scopes
    db.commit()
    db.refresh(account)
    return account


def delete_account(db: Session, account: GoogleAccount) -> None:
    """Disconnect.

    Only the local tokens go. Revoking the grant at Google's end is the user's
    to do from their account page, and doing it here would be a surprise —
    "disconnect from MiO" is not "sign MiO out of everything for ever".
    """
    db.delete(account)
    db.commit()


def get_fresh_access_token(
    db: Session, account: GoogleAccount, client_id: str, client_secret: str
) -> str:
    """A usable access token, refreshing and persisting a stale one.

    Raises `GoogleAuthError` through the refresh when the authorization is gone
    — revoked, or expired under the 7-day Testing rule. Both mean reconnect and
    the caller cannot tell them apart, which is why they share an exception.
    """
    expires_at = account.token_expires_at
    if expires_at.tzinfo is None:
        # SQLite hands timestamps back naive; they were stored as UTC.
        expires_at = expires_at.replace(tzinfo=UTC)
    if expires_at - TOKEN_REFRESH_SKEW > datetime.now(UTC):
        return account.access_token

    tokens = refresh_token_set(client_id, client_secret, account.refresh_token)
    account.access_token = tokens.access_token
    # Carried even though Google does not rotate it, so this stays correct if
    # that ever changes — `refresh_token_set` already falls back to the old one.
    account.refresh_token = tokens.refresh_token
    account.token_expires_at = tokens.expires_at
    db.commit()
    return tokens.access_token
