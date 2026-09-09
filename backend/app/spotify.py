"""Thin wrapper around the Spotify Web API: PKCE, tokens, current user.

Mirrors the app/ytdlp.py pattern — module-level functions with their own
exception types, no DB access — so the rest of the app never touches httpx
directly and tests can monkeypatch these names where they're consumed.
Token persistence lives in app/spotify_accounts.py.
"""

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx

AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"

# Read-only: the user's own playlists (incl. collaborative) and Liked Songs.
SCOPES = ("playlist-read-private", "playlist-read-collaborative", "user-library-read")

_MAX_ATTEMPTS = 3
_RETRY_AFTER_CAP = 30.0
_TIMEOUT = 15.0

# Test seam: tests install an httpx.MockTransport here to fake the API.
_transport: httpx.BaseTransport | None = None


class SpotifyError(Exception):
    """Raised when a Spotify request fails after retries."""


class SpotifyAuthError(SpotifyError):
    """Raised when Spotify rejects the authorization itself (401/403/revoked)."""


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str
    expires_at: datetime
    scopes: str


@dataclass
class SpotifyUser:
    id: str
    display_name: str | None


def code_challenge_from_verifier(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def generate_pkce_pair() -> tuple[str, str]:
    """Return a (code_verifier, code_challenge) pair per RFC 7636."""
    verifier = secrets.token_urlsafe(64)  # 86 chars, inside the RFC's 43–128 window
    return verifier, code_challenge_from_verifier(verifier)


def build_authorize_url(client_id: str, redirect_uri: str, state: str, code_challenge: str) -> str:
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "state": state,
        "scope": " ".join(SCOPES),
        "code_challenge_method": "S256",
        "code_challenge": code_challenge,
        # Always show the consent screen: the dev-mode app serves up to five
        # people from the same machine, and without this Spotify silently
        # reuses whoever logged in last instead of offering to switch account.
        "show_dialog": "true",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def _retry_after_seconds(response: httpx.Response) -> float:
    try:
        return min(float(response.headers.get("Retry-After", 1)), _RETRY_AFTER_CAP)
    except ValueError:
        return 1.0


def _request(
    method: str,
    url: str,
    *,
    token: str | None = None,
    data: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
) -> httpx.Response:
    headers = {"Authorization": f"Bearer {token}"} if token is not None else None
    last_error = "unknown error"
    for attempt in range(_MAX_ATTEMPTS):
        retry_delay = 2.0
        try:
            with httpx.Client(transport=_transport, timeout=_TIMEOUT) as client:
                response = client.request(method, url, headers=headers, data=data, params=params)
        except httpx.HTTPError as exc:
            last_error = f"network error: {exc}"
        else:
            if response.status_code == 401:
                raise SpotifyAuthError(
                    "Spotify rejected the stored credentials (401) — reconnect the account"
                )
            if response.status_code == 403:
                raise SpotifyAuthError(
                    "Spotify rejected the request (403) — the app owner's Premium may have "
                    "lapsed, or this account is not on the app's allowlist"
                )
            if response.status_code == 429:
                last_error = "rate limited (429)"
                retry_delay = _retry_after_seconds(response)
            elif response.status_code >= 500:
                last_error = f"server error ({response.status_code})"
            elif response.status_code == 400 and "invalid_grant" in response.text:
                raise SpotifyAuthError(
                    "Spotify authorization was revoked or expired — reconnect the account"
                )
            elif response.status_code >= 400:
                raise SpotifyError(
                    f"Spotify request failed ({response.status_code}): {response.text[:200]}"
                )
            else:
                return response
        if attempt < _MAX_ATTEMPTS - 1:
            time.sleep(retry_delay)
    raise SpotifyError(f"Spotify request failed after {_MAX_ATTEMPTS} attempts: {last_error}")


def _parse_token_response(payload: dict, *, fallback_refresh_token: str | None = None) -> TokenSet:
    refresh_token = payload.get("refresh_token") or fallback_refresh_token
    access_token = payload.get("access_token")
    if not access_token or not refresh_token:
        raise SpotifyError("Spotify token response was missing expected fields")
    expires_at = datetime.now(UTC) + timedelta(seconds=int(payload.get("expires_in", 3600)))
    return TokenSet(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_at=expires_at,
        scopes=payload.get("scope", ""),
    )


def exchange_code(client_id: str, code: str, redirect_uri: str, code_verifier: str) -> TokenSet:
    response = _request(
        "POST",
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "code_verifier": code_verifier,
        },
    )
    return _parse_token_response(response.json())


def refresh_token_set(client_id: str, refresh_token: str) -> TokenSet:
    """Trade a refresh token for a fresh access token.

    Spotify may or may not rotate the refresh token; when the response omits
    one, the old token stays valid and is carried over.
    """
    response = _request(
        "POST",
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
        },
    )
    return _parse_token_response(response.json(), fallback_refresh_token=refresh_token)


def get_current_user(access_token: str) -> SpotifyUser:
    response = _request("GET", f"{API_BASE}/me", token=access_token)
    payload = response.json()
    return SpotifyUser(id=payload["id"], display_name=payload.get("display_name"))


@dataclass
class SpotifyPlaylist:
    id: str
    name: str
    image_url: str | None
    track_count: int
    owner_name: str | None


@dataclass
class SpotifyTrack:
    external_id: str | None
    title: str
    artist: str
    album: str | None
    duration_s: float | None


_PAGE_LIMIT = 50  # Spotify's maximum page size for the endpoints used here.


def list_playlists(
    access_token: str, limit: int = _PAGE_LIMIT, offset: int = 0
) -> tuple[list[SpotifyPlaylist], int]:
    """One page of the user's own playlists, plus the overall total."""
    response = _request(
        "GET",
        f"{API_BASE}/me/playlists",
        token=access_token,
        params={"limit": str(limit), "offset": str(offset)},
    )
    payload = response.json()
    playlists = []
    for item in payload.get("items") or []:
        if not item:
            continue
        images = item.get("images") or []
        # The playlist object's track listing moved from `tracks` to `items`
        # in the February 2026 API migration; accept either.
        track_info = item.get("items") or item.get("tracks") or {}
        playlists.append(
            SpotifyPlaylist(
                id=item["id"],
                name=item.get("name") or "Untitled playlist",
                image_url=images[0].get("url") if images else None,
                track_count=int(track_info.get("total") or 0),
                owner_name=(item.get("owner") or {}).get("display_name"),
            )
        )
    return playlists, int(payload.get("total") or len(playlists))


def _parse_track(obj: dict | None) -> SpotifyTrack | None:
    """A track object -> SpotifyTrack; None for gaps (removed items, episodes)."""
    if not obj or obj.get("type") not in (None, "track") or not obj.get("name"):
        return None
    artists = ", ".join(a.get("name", "") for a in obj.get("artists") or [] if a.get("name"))
    duration_ms = obj.get("duration_ms")
    return SpotifyTrack(
        external_id=obj.get("id"),
        title=obj["name"],
        artist=artists or "Unknown artist",
        album=(obj.get("album") or {}).get("name"),
        duration_s=duration_ms / 1000 if duration_ms else None,
    )


def _fetch_all_pages(access_token: str, url: str, entry_key: str) -> list[SpotifyTrack]:
    tracks: list[SpotifyTrack] = []
    offset = 0
    while True:
        response = _request(
            "GET",
            url,
            token=access_token,
            params={"limit": str(_PAGE_LIMIT), "offset": str(offset)},
        )
        payload = response.json()
        entries = payload.get("items") or []
        for entry in entries:
            if not entry:
                continue
            # Playlist entries renamed `track` -> `item` in the February 2026
            # migration; saved tracks still use `track`. Accept both.
            track = _parse_track(entry.get(entry_key) or entry.get("track"))
            if track is not None:
                tracks.append(track)
        offset += len(entries)
        if not entries or payload.get("next") is None:
            return tracks


def fetch_all_playlist_tracks(access_token: str, playlist_id: str) -> list[SpotifyTrack]:
    return _fetch_all_pages(
        access_token, f"{API_BASE}/playlists/{playlist_id}/items", entry_key="item"
    )


def fetch_all_saved_tracks(access_token: str) -> list[SpotifyTrack]:
    """The user's Liked Songs."""
    return _fetch_all_pages(access_token, f"{API_BASE}/me/tracks", entry_key="track")
