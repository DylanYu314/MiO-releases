"""Google OAuth and private YouTube playlist listing (#106).

/login and /callback have a person's browser on the other end, not an API
client, so they speak 302s — the same shape `routers/spotify.py` uses, and for
the same reasons. The docstring there explains the pending-state store and why
the return target is an enum rather than a URL; both apply here verbatim.

## What this router deliberately does not do

**It never downloads anything.** A private playlist hands back video ids, so
there is nothing to match and nothing to review (2026-08-12: *"its from
youtube, user know what they importing"*). `/playlists/{id}/items` returns the
ids and the phone fetches each one itself, exactly as a pasted link already does
(#246).

That is not only simpler, it is the architecture: the server never holds the
audio, so there is no `confirm-receipt` handover and nothing to release. And
#177 does not apply — the bot check is about yt-dlp scraping from the droplet,
while the Data API is authenticated and answers a datacenter address perfectly
well.

## Why the listing endpoints are gated and the local ones are not

`GET /playlists` and `/playlists/{id}/items` read **the owner's** YouTube
account and spend **the project's** quota, so they sit behind the access-key
gate the same way search and playlist import do (ADR-009).

⚠️ **A connected account is global**, exactly as `SpotifyAccount` is: this
server is single-user, so anyone holding a valid access key can list the owner's
private playlists. That is the existing bargain rather than a new one, but it is
worth stating plainly, because "private" here means private from the public —
not private from other key holders.

`/status` and `DELETE /account` are ungated and unconfigured-safe, so the screen
can still say what is going on after the credentials are removed.
"""

import secrets
import threading
import time
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.access_keys import require_unlock_key
from app.config import Settings, get_settings
from app.db import get_db
from app.google import (
    GoogleAuthError,
    GoogleError,
    GoogleQuotaError,
    build_authorize_url,
    exchange_code,
    fetch_all_playlist_items,
    get_current_channel,
    list_playlists,
)
from app.google_accounts import delete_account, get_account, get_fresh_access_token, upsert_account
from app.schemas import GooglePlaylistRead, GoogleStatusRead, GoogleTrackRead

router = APIRouter(prefix="/google", tags=["google"])

# How long a started-but-unfinished login stays redeemable.
PENDING_AUTH_TTL = 600.0

# Which client started the login, so the callback knows where to send the
# browser back to. Two values, both resolved server-side — a `return_to=<url>`
# parameter would be an open redirect with an OAuth code attached to it.
GoogleClient = Literal["web", "app"]

_pending_auth: dict[str, tuple[GoogleClient, float]] = {}
_pending_lock = threading.Lock()

# Which 401 this is.
#
# **Two unrelated things answer 401 on the listing endpoints, and they ask the
# user for opposite actions.** The access-key gate (ADR-009) means *this client
# has no valid key*; a dead Google authorization means *reconnect the account*.
# A client that can only read the status has to guess between them — and while
# the consent screen is in Testing the second one happens **every 7 days**, so
# guessing wrong turns a scheduled expiry into "your access key is wrong",
# which is precisely the weekly disconnect looking like a bug in MiO.
#
# In the **body** rather than a response header, deliberately: a custom header
# is invisible to a browser unless CORS exposes it, so a header would work on
# the phone and fail silently on the web — the shape of fault this project has
# already paid for (#478, `patch-package`).
GOOGLE_REAUTH = "google_reauth"


def _reauth(exc: Exception) -> HTTPException:
    """401, saying *which* 401 it is. `message` keeps `detail`'s existing job of
    carrying something a human can read."""
    return HTTPException(status_code=401, detail={"code": GOOGLE_REAUTH, "message": str(exc)})


def require_google_settings() -> Settings:
    """For endpoints that actually talk to Google.

    `/status` and disconnect skip this, so the UI keeps working — and keeps
    being able to say why — after the credentials are removed.
    """
    settings = get_settings()
    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(
            status_code=503,
            detail=(
                "Google integration is not configured "
                "(set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)"
            ),
        )
    return settings


def _stash_pending(state: str, client: GoogleClient) -> None:
    now = time.monotonic()
    with _pending_lock:
        expired = [key for key, (_, at) in _pending_auth.items() if now - at > PENDING_AUTH_TTL]
        for stale in expired:
            del _pending_auth[stale]
        _pending_auth[state] = (client, now)


def _pop_pending(state: str | None) -> GoogleClient | None:
    """Consume a pending login. `None` means the state is unknown or expired,
    which is the CSRF check: a callback whose state we never issued is not one
    of ours."""
    if state is None:
        return None
    with _pending_lock:
        entry = _pending_auth.pop(state, None)
    if entry is None:
        return None
    client, created = entry
    if time.monotonic() - created > PENDING_AUTH_TTL:
        return None
    return client


def _client_redirect(settings: Settings, client: GoogleClient, **params: str) -> RedirectResponse:
    base = (
        settings.spotify_app_redirect_uri
        if client == "app"
        else f"{settings.frontend_base_url}/import"
    )
    return RedirectResponse(f"{base}?{urlencode(params)}", status_code=302)


def _connected_account(db: Session):
    account = get_account(db)
    if account is None:
        raise HTTPException(status_code=404, detail="No Google account is connected")
    return account


def _token(db: Session, account, settings: Settings) -> str:
    """A usable access token, or an HTTP error that says what to do about it.

    The three failures want three different answers, which is the whole reason
    `app/google.py` gives them separate types: reconnect, wait, or try again.
    """
    try:
        return get_fresh_access_token(
            db, account, settings.google_client_id or "", settings.google_client_secret or ""
        )
    except GoogleAuthError as exc:
        # 401, not 502: the *client* has something to do about this — reconnect.
        # While the consent screen is in Testing this happens every 7 days.
        raise _reauth(exc) from exc
    except GoogleError as exc:
        raise HTTPException(
            status_code=502, detail="Google connection unavailable — try again later"
        ) from exc


def _call(operation, *args):
    """Run one Data API call, mapping its failures onto status codes.

    `GoogleQuotaError` becomes **429**, not 502: a spent quota is the one
    failure that waiting fixes, and it resets at midnight Pacific. Telling a
    user "try again later" is true here and false for the others.
    """
    try:
        return operation(*args)
    except GoogleQuotaError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except GoogleAuthError as exc:
        raise _reauth(exc) from exc
    except GoogleError as exc:
        raise HTTPException(
            status_code=502, detail="Google connection unavailable — try again later"
        ) from exc


@router.get("/login")
def google_login(
    client: GoogleClient = "web",
    settings: Settings = Depends(require_google_settings),
) -> RedirectResponse:
    state = secrets.token_urlsafe(16)
    _stash_pending(state, client)
    return RedirectResponse(
        build_authorize_url(
            client_id=settings.google_client_id or "",
            redirect_uri=settings.google_redirect_uri,
            state=state,
        ),
        status_code=302,
    )


@router.get("/callback")
def google_callback(
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    settings: Settings = Depends(require_google_settings),
    db: Session = Depends(get_db),
) -> RedirectResponse:
    client = _pop_pending(state)
    # An unknown or expired state has no client recorded, so the web client is
    # the only honest destination — guessing "app" would send a browser to a
    # scheme it cannot open, and the error would be invisible.
    target: GoogleClient = client if client is not None else "web"

    if error is not None:
        return _client_redirect(settings, target, google_error="access_denied")
    if code is None or client is None:
        return _client_redirect(settings, target, google_error="state_mismatch")

    try:
        tokens = exchange_code(
            settings.google_client_id or "",
            settings.google_client_secret or "",
            code,
            settings.google_redirect_uri,
        )
        channel = get_current_channel(tokens.access_token)
    except GoogleError:
        # Includes the account having no YouTube channel at all, which is a real
        # state rather than a fault — and one the user can only fix on YouTube.
        return _client_redirect(settings, target, google_error="exchange_failed")

    upsert_account(db, tokens, channel)
    return _client_redirect(settings, target, connected="google")


@router.get("/status", response_model=GoogleStatusRead)
def google_status(db: Session = Depends(get_db)) -> GoogleStatusRead:
    settings = get_settings()
    account = get_account(db)
    return GoogleStatusRead(
        configured=bool(settings.google_client_id and settings.google_client_secret),
        channel_id=account.channel_id if account else None,
        channel_title=account.channel_title if account else None,
        connected_at=account.created_at if account else None,
    )


@router.get("/playlists", response_model=list[GooglePlaylistRead])
def google_playlists(
    settings: Settings = Depends(require_google_settings),
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
) -> list[GooglePlaylistRead]:
    """The connected channel's own playlists, private ones included.

    Unpaged, deliberately: `list_playlists` follows every page itself, one quota
    unit per fifty, and a person has tens of playlists rather than thousands.
    Paging this would add a cursor to the API for a list that arrives in a
    single call.
    """
    account = _connected_account(db)
    token = _token(db, account, settings)
    playlists = _call(list_playlists, token)
    return [
        GooglePlaylistRead(
            id=playlist.id,
            title=playlist.title,
            track_count=playlist.track_count,
            privacy=playlist.privacy,
        )
        for playlist in playlists
    ]


@router.get("/playlists/{playlist_id}/items", response_model=list[GoogleTrackRead])
def google_playlist_items(
    playlist_id: str,
    settings: Settings = Depends(require_google_settings),
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
) -> list[GoogleTrackRead]:
    """Every video in one playlist, for the device to fetch itself.

    This is the whole handover: the response is a list of video ids, and the
    phone downloads each one the way it already downloads a pasted link. The
    server does not queue a job, does not match anything, and never touches the
    audio.

    Entries whose video has been deleted or made private are already dropped by
    `fetch_all_playlist_items` — YouTube keeps the row with a placeholder title,
    and importing those would produce songs called "Deleted video".
    """
    account = _connected_account(db)
    token = _token(db, account, settings)
    tracks = _call(fetch_all_playlist_items, token, playlist_id)
    return [
        GoogleTrackRead(
            video_id=track.video_id, title=track.title, channel_title=track.channel_title
        )
        for track in tracks
    ]


@router.delete("/account", status_code=204)
def google_disconnect(
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
) -> None:
    """Forget the connected account.

    Local tokens only. Revoking the grant at Google's end is the user's to do
    from their own account page, and doing it here would make "disconnect from
    MiO" quietly mean "sign MiO out of everything for ever".

    ⚠️ **Access-key gated since #514**, for the same reason as its Spotify
    twin: it had no guard at all, and the sibling reads on this router
    (`/google/status`, `/google/playlists`) were already gated. Disconnecting
    is a larger act than listing, so an ungated delete beside gated reads was
    an inconsistency, not a decision.
    """
    delete_account(db, _connected_account(db))
