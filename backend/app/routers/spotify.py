"""Spotify OAuth (Authorization Code + PKCE) and connected-account management.

/login and /callback have a person's browser on the other end, not an API
client, so they speak 302s: /login bounces to Spotify's consent page, and
/callback always bounces back to the client that started it — carrying either
?connected=<id> or ?spotify_error=<slug>, never a raw error page.

Pending state→verifier pairs live in process memory. Same justification as
the event broker (ADR-004/ADR-005): single process, DB stays the source of
truth for everything durable — a restart just means clicking Connect again.

## Two clients, and why the choice is stashed rather than passed (#203)

The Android app needs the callback to land back in the app, not on the web
client, so /login takes ?client=app|web and the callback honours it.

**Spotify does not carry it for us.** The redirect URI is fixed and registered
in their dashboard, and only `state` comes back — so the choice rides in the
same slot the PKCE verifier already does, keyed by that state. Adding it to
the redirect URI instead would need a second URI registered per client and
would still not survive an error response.

**It is an enum, never a URL.** A `return_to=<anything>` parameter here would
be an open redirect with an OAuth code attached to it: hand a tester a crafted
/login link and their Spotify authorization lands on someone else's host. Two
named clients resolve to two values this server already holds.
"""

import secrets
import threading
import time
from dataclasses import asdict
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.access_keys import require_unlock_key
from app.config import Settings, get_settings
from app.db import get_db
from app.models import SpotifyAccount
from app.schemas import Page, SpotifyAccountRead, SpotifyPlaylistRead, SpotifyStatusRead
from app.spotify import (
    SpotifyAuthError,
    SpotifyError,
    build_authorize_url,
    exchange_code,
    generate_pkce_pair,
    get_current_user,
    list_playlists,
)
from app.spotify_accounts import get_fresh_access_token, upsert_account

router = APIRouter(prefix="/spotify", tags=["spotify"])

# How long a started-but-unfinished login stays redeemable.
PENDING_AUTH_TTL = 600.0

# Which client started a login, so the callback knows where to send the browser
# back to. Two values, both resolved server-side — see the module docstring on
# why this is not a URL.
SpotifyClient = Literal["web", "app"]

_pending_auth: dict[str, tuple[str, SpotifyClient, float]] = {}
_pending_lock = threading.Lock()


def require_spotify_settings() -> Settings:
    """Dependency for endpoints that talk to Spotify. Local-only endpoints
    (status, disconnect) skip it so they keep working after the integration
    is unconfigured or the owner's Premium lapses."""
    settings = get_settings()
    if not settings.spotify_client_id:
        raise HTTPException(
            status_code=503,
            detail="Spotify integration is not configured (set SPOTIFY_CLIENT_ID)",
        )
    return settings


def _stash_pending(state: str, verifier: str, client: SpotifyClient) -> None:
    now = time.monotonic()
    with _pending_lock:
        expired = [s for s, (_, _, at) in _pending_auth.items() if now - at > PENDING_AUTH_TTL]
        for stale in expired:
            del _pending_auth[stale]
        _pending_auth[state] = (verifier, client, now)


def _pop_pending(state: str | None) -> tuple[str, SpotifyClient] | None:
    if state is None:
        return None
    with _pending_lock:
        entry = _pending_auth.pop(state, None)
    if entry is None:
        return None
    verifier, client, created = entry
    if time.monotonic() - created > PENDING_AUTH_TTL:
        return None
    return verifier, client


def _client_redirect(settings: Settings, client: SpotifyClient, **params: str) -> RedirectResponse:
    """Back to whichever client started the login.

    The app target is a deep link into the import screen — `mio://add/import`,
    which is what expo-router resolves `app/(tabs)/add/import/index.tsx` to
    (route groups are not path segments). It is a setting rather than a
    constant so the scheme can change without a code change, but it is still
    chosen from a fixed pair here, never supplied by the caller.
    """
    base = (
        settings.spotify_app_redirect_uri
        if client == "app"
        else f"{settings.frontend_base_url}/import"
    )
    return RedirectResponse(f"{base}?{urlencode(params)}", status_code=302)


@router.get("/login")
def spotify_login(
    client: SpotifyClient = "web",
    settings: Settings = Depends(require_spotify_settings),
) -> RedirectResponse:
    state = secrets.token_urlsafe(16)
    verifier, challenge = generate_pkce_pair()
    _stash_pending(state, verifier, client)
    url = build_authorize_url(
        client_id=settings.spotify_client_id,
        redirect_uri=settings.spotify_redirect_uri,
        state=state,
        code_challenge=challenge,
    )
    return RedirectResponse(url, status_code=302)


@router.get("/callback")
def spotify_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    settings: Settings = Depends(require_spotify_settings),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    pending = _pop_pending(state)
    # An unknown or expired state has no client recorded, so the web client is
    # the only honest destination — guessing "app" would send a browser to a
    # scheme it cannot open, and the error would be invisible.
    client: SpotifyClient = pending[1] if pending is not None else "web"

    if error is not None:
        return _client_redirect(settings, client, spotify_error="access_denied")
    if code is None or pending is None:
        return _client_redirect(settings, client, spotify_error="state_mismatch")

    verifier = pending[0]
    try:
        tokens = exchange_code(
            client_id=settings.spotify_client_id,
            code=code,
            redirect_uri=settings.spotify_redirect_uri,
            code_verifier=verifier,
        )
        user = get_current_user(tokens.access_token)
    except SpotifyError:
        return _client_redirect(settings, client, spotify_error="exchange_failed")

    account = upsert_account(db, tokens, user)
    return _client_redirect(settings, client, connected=str(account.id))


@router.get("/status", response_model=SpotifyStatusRead)
def spotify_status(db: Session = Depends(get_db)) -> SpotifyStatusRead:
    accounts = db.scalars(
        select(SpotifyAccount).order_by(SpotifyAccount.created_at, SpotifyAccount.id)
    ).all()
    return SpotifyStatusRead(
        configured=bool(get_settings().spotify_client_id),
        accounts=[SpotifyAccountRead.model_validate(account) for account in accounts],
    )


@router.get("/playlists", response_model=Page[SpotifyPlaylistRead])
def spotify_playlists(
    account_id: int,
    limit: int = Query(50, ge=1, le=50),
    offset: int = Query(0, ge=0),
    settings: Settings = Depends(require_spotify_settings),
    db: Session = Depends(get_db),
) -> Page[SpotifyPlaylistRead]:
    """Proxy one page of the account's own playlists. Kept inline (not a job)
    because it's a single sub-second metadata call, not pipeline work."""
    account = db.get(SpotifyAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Spotify account not found")

    try:
        token = get_fresh_access_token(db, account, settings.spotify_client_id or "")
        playlists, total = list_playlists(token, limit=limit, offset=offset)
    except SpotifyAuthError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except SpotifyError as exc:
        raise HTTPException(
            status_code=502, detail="Spotify connection unavailable — try again later"
        ) from exc

    return Page[SpotifyPlaylistRead](
        items=[SpotifyPlaylistRead(**asdict(playlist)) for playlist in playlists],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.delete("/accounts/{account_id}", status_code=204)
def disconnect_account(
    account_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
) -> None:
    """Forget a connected account. Local tokens only — Spotify has no token
    revocation endpoint; users revoke app access from their own Spotify
    account settings.

    ⚠️ **Access-key gated since #514.** This took an integer and deleted the
    row with no guard of any kind, so anyone who could reach the server could
    walk `1..n` and disconnect every connected account. Not a disclosure — the
    tokens are destroyed, not revealed — but unauthenticated state mutation,
    and trivially repeatable.

    ⚠️ Gated by **key**, not by owner, deliberately: `SpotifyAccount` has no
    `owner_install_id`. Accounts are global because the app is single-user
    (see `models.py`), so there is no owner to scope to and inventing one here
    would be a schema change wearing a security fix's clothes. The key is the
    guard that matches the model as it stands.
    """
    account = db.get(SpotifyAccount, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Spotify account not found")
    db.delete(account)
    db.commit()
