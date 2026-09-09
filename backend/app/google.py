"""Thin wrapper around Google OAuth and the YouTube Data API (#106).

Mirrors app/spotify.py deliberately — module-level functions, own exception
types, no DB access — so the rest of the app never touches httpx directly and
tests can monkeypatch these names where they are consumed. Token persistence
lives in app/google_accounts.py, the same split spotify_accounts.py has.

## Three ways this is not Spotify

1. **A client secret, not PKCE.** Google issues one for "Web application"
   clients and requires it at the token exchange, so it is a parameter here
   where Spotify needed only a client id. It must never leave the server.
2. **`access_type=offline` and `prompt=consent` are load-bearing.** Without the
   first, Google returns no refresh token at all; without the second, a *repeat*
   authorization returns none either, because Google only issues one the first
   time an account grants a scope. Both together are the difference between an
   integration that survives an hour and one that survives a week.
3. **Refresh responses never carry a new refresh token.** Spotify may rotate
   one; Google does not, so the stored token is always carried forward.

## The 7-day expiry is not modelled here

While the OAuth consent screen is in "Testing", Google expires the *refresh*
token after seven days and the next refresh fails with `invalid_grant`. That is
indistinguishable from a revoked grant at this layer and is handled the same
way: `GoogleAuthError`, meaning reconnect. `docs/google-oauth-setup.md` records
why it happens and what it would cost to remove.
"""

import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import urlencode

import httpx

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
API_BASE = "https://www.googleapis.com/youtube/v3"

# Read-only, and one scope only. MiO lists playlists; it never modifies a
# channel. Asking for less is safer if a token leaks and cheaper if the app is
# ever put through Google's verification, where every extra scope is reviewed.
SCOPES = ("https://www.googleapis.com/auth/youtube.readonly",)

# The API's own page size for these endpoints. Both playlists.list and
# playlistItems.list cost 1 quota unit per call regardless, so larger pages are
# strictly cheaper against the 10,000/day allowance.
_PAGE_SIZE = 50

_MAX_ATTEMPTS = 3
_RETRY_AFTER_CAP = 30.0
_TIMEOUT = 15.0

# Test seam: tests install an httpx.MockTransport here to fake the API.
_transport: httpx.BaseTransport | None = None


class GoogleError(Exception):
    """Raised when a Google request fails after retries."""


class GoogleAuthError(GoogleError):
    """Raised when Google rejects the authorization itself.

    Includes the 7-day Testing-mode expiry, which arrives as `invalid_grant`
    and is not distinguishable from a user revoking access. Both mean the same
    thing to a caller: the account has to be connected again.
    """


class GoogleQuotaError(GoogleError):
    """The project's daily quota is spent.

    Its own type because it is the one failure that **waiting fixes** — the
    allowance resets at midnight Pacific — and telling a user to reconnect
    would send them to do something useless. Spotify has no equivalent.
    """


@dataclass
class TokenSet:
    access_token: str
    refresh_token: str
    expires_at: datetime
    scopes: str


@dataclass
class GoogleChannel:
    """The identity a connected account is keyed on.

    A *channel*, not a Google user: `youtube.readonly` grants no access to
    profile or email, and a channel id is what every other call here is scoped
    to anyway. It also means the account row says something a user recognises —
    their channel name — rather than an opaque subject id.
    """

    id: str
    title: str | None


@dataclass
class GooglePlaylist:
    id: str
    title: str
    track_count: int
    # "private", "public" or "unlisted". Carried because the whole point of
    # #106 is the playlists the public path cannot see, and a UI that cannot
    # say which those are is hiding the reason the feature exists.
    privacy: str | None


@dataclass
class GoogleTrack:
    video_id: str
    title: str
    channel_title: str | None


def build_authorize_url(client_id: str, redirect_uri: str, state: str) -> str:
    """Where to send the browser to start a login.

    `access_type=offline` and `prompt=consent` are not optional here — see this
    module's docstring. `include_granted_scopes` lets a future scope be added
    without dropping the ones already granted.
    """
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "state": state,
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def _retry_after_seconds(response: httpx.Response) -> float:
    try:
        return min(float(response.headers.get("Retry-After", 1)), _RETRY_AFTER_CAP)
    except ValueError:
        return 1.0


def _is_quota_error(response: httpx.Response) -> bool:
    """Tell a spent quota from ordinary rate limiting.

    Both are 403 on this API, and they want opposite responses: a quota is
    spent until midnight Pacific and retrying is pointless, while a burst limit
    clears in seconds. The reason code is the only thing that separates them,
    so it is read rather than the status.
    """
    try:
        errors = response.json().get("error", {}).get("errors", [])
    except ValueError:
        return False
    return any(item.get("reason") in {"quotaExceeded", "dailyLimitExceeded"} for item in errors)


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
                raise GoogleAuthError(
                    "Google rejected the stored credentials (401) — reconnect the account"
                )
            if response.status_code == 403:
                # Checked before the generic 403, because a spent quota is not
                # an authorization problem and must not read as one.
                if _is_quota_error(response):
                    raise GoogleQuotaError(
                        "the project's daily YouTube API quota is spent — it resets at "
                        "midnight Pacific time"
                    )
                raise GoogleAuthError(
                    "Google refused the request (403) — the account may not be a test user "
                    "on this app, or the YouTube Data API is not enabled for the project"
                )
            if response.status_code == 429:
                last_error = "rate limited (429)"
                retry_delay = _retry_after_seconds(response)
            elif response.status_code >= 500:
                last_error = f"server error ({response.status_code})"
            elif response.status_code == 400 and "invalid_grant" in response.text:
                raise GoogleAuthError(
                    "Google authorization has expired or been revoked — reconnect the account. "
                    "While the consent screen is in Testing this happens every 7 days."
                )
            elif response.status_code >= 400:
                raise GoogleError(
                    f"Google request failed ({response.status_code}): {response.text[:200]}"
                )
            else:
                return response
        if attempt < _MAX_ATTEMPTS - 1:
            time.sleep(retry_delay)
    raise GoogleError(f"Google request failed after {_MAX_ATTEMPTS} attempts: {last_error}")


def _parse_token_response(payload: dict, *, fallback_refresh_token: str | None = None) -> TokenSet:
    refresh_token = payload.get("refresh_token") or fallback_refresh_token
    access_token = payload.get("access_token")
    if not access_token:
        raise GoogleError("Google token response had no access token")
    if not refresh_token:
        # Reached when a re-authorization comes back without one, which is what
        # Google does unless `prompt=consent` was sent. Named rather than stored
        # as an empty string, because the failure would otherwise surface a week
        # later as an unrefreshable account.
        raise GoogleError(
            "Google returned no refresh token — the authorize URL must send "
            "access_type=offline and prompt=consent"
        )
    expires_at = datetime.now(UTC) + timedelta(seconds=int(payload.get("expires_in", 3600)))
    return TokenSet(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_at=expires_at,
        scopes=payload.get("scope", ""),
    )


def exchange_code(client_id: str, client_secret: str, code: str, redirect_uri: str) -> TokenSet:
    response = _request(
        "POST",
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )
    return _parse_token_response(response.json())


def refresh_token_set(client_id: str, client_secret: str, refresh_token: str) -> TokenSet:
    """Trade a refresh token for a fresh access token.

    Google never returns a new refresh token here, so the existing one is always
    carried forward. Spotify's equivalent has to handle both cases; this one
    would be a silent logout if the fallback were omitted.
    """
    response = _request(
        "POST",
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
    )
    return _parse_token_response(response.json(), fallback_refresh_token=refresh_token)


def get_current_channel(access_token: str) -> GoogleChannel:
    """Whose account this is.

    `mine=true` needs no channel id and costs 1 unit. A Google account with no
    YouTube channel answers with an empty list — a real state, not an error, and
    one worth naming because such an account can sign in and then have nothing
    to import.
    """
    response = _request(
        "GET",
        f"{API_BASE}/channels",
        token=access_token,
        params={"part": "snippet", "mine": "true"},
    )
    items = response.json().get("items", [])
    if not items:
        raise GoogleError("this Google account has no YouTube channel, so it has no playlists")
    channel = items[0]
    return GoogleChannel(id=channel["id"], title=channel.get("snippet", {}).get("title"))


def _paged(access_token: str, path: str, params: dict[str, str]) -> list[dict]:
    """Every page of a list endpoint, following `nextPageToken`.

    Each page is 1 quota unit, so a 500-item playlist costs 10 of the 10,000
    daily allowance — the arithmetic that decided this design is affordable
    (`docs/google-oauth-setup.md`).
    """
    items: list[dict] = []
    page_token: str | None = None
    while True:
        query = {**params, "maxResults": str(_PAGE_SIZE)}
        if page_token:
            query["pageToken"] = page_token
        payload = _request("GET", f"{API_BASE}/{path}", token=access_token, params=query).json()
        items.extend(payload.get("items", []))
        page_token = payload.get("nextPageToken")
        if not page_token:
            return items


def list_playlists(access_token: str) -> list[GooglePlaylist]:
    """The signed-in channel's own playlists, private ones included.

    `mine=true` is what makes this different from the public path MiO already
    has: it returns the playlists the account owns rather than the ones the
    world can see, which is the whole of #106.
    """
    items = _paged(
        access_token,
        "playlists",
        {"part": "snippet,contentDetails,status", "mine": "true"},
    )
    return [
        GooglePlaylist(
            id=item["id"],
            title=item.get("snippet", {}).get("title", ""),
            track_count=item.get("contentDetails", {}).get("itemCount", 0),
            privacy=item.get("status", {}).get("privacyStatus"),
        )
        for item in items
    ]


# What YouTube puts in the title of an entry whose video is gone or hidden. The
# row still exists in the playlist, so it has to be recognised rather than
# imported as a song literally called "Private video".
UNAVAILABLE_TITLES = frozenset({"Private video", "Deleted video"})


def fetch_all_playlist_items(access_token: str, playlist_id: str) -> list[GoogleTrack]:
    """Every track in one playlist, skipping entries that no longer resolve.

    A playlist of any age contains videos that have been deleted or made
    private, and YouTube keeps the row with a placeholder title. Importing those
    would produce songs named "Deleted video" that can never be matched — so
    they are dropped here, where the reason is visible, rather than failing one
    by one in the downloader.
    """
    items = _paged(
        access_token,
        "playlistItems",
        {"part": "snippet,contentDetails", "playlistId": playlist_id},
    )
    tracks: list[GoogleTrack] = []
    for item in items:
        snippet = item.get("snippet", {})
        title = snippet.get("title", "")
        video_id = item.get("contentDetails", {}).get("videoId")
        if not video_id or title in UNAVAILABLE_TITLES:
            continue
        tracks.append(
            GoogleTrack(
                video_id=video_id,
                title=title,
                # The uploader, which is what the matcher treats as the artist.
                # `videoOwnerChannelTitle` is absent on unavailable entries and
                # occasionally on very old ones, so it stays optional.
                channel_title=snippet.get("videoOwnerChannelTitle"),
            )
        )
    return tracks
