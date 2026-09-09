import json
from urllib.parse import parse_qsl, urlsplit

import httpx
import pytest

import app.google as google
from app.google import (
    GoogleAuthError,
    GoogleError,
    GoogleQuotaError,
    build_authorize_url,
    exchange_code,
    fetch_all_playlist_items,
    get_current_channel,
    list_playlists,
    refresh_token_set,
)

CLIENT_ID = "87905281425-example.apps.googleusercontent.com"
CLIENT_SECRET = "GOCSPX-not-a-real-secret"
REDIRECT_URI = "http://localhost:8000/google/callback"


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Capture retry waits instead of actually sleeping."""
    recorded: list[float] = []
    monkeypatch.setattr(google.time, "sleep", recorded.append)
    return recorded


@pytest.fixture
def transport(monkeypatch: pytest.MonkeyPatch):
    def install(handler) -> None:
        monkeypatch.setattr(google, "_transport", httpx.MockTransport(handler))

    return install


def form_body(request: httpx.Request) -> dict[str, str]:
    return dict(parse_qsl(request.content.decode()))


def quota_response() -> httpx.Response:
    """What the API actually sends when the daily allowance is spent: a 403
    whose *reason* is the only thing separating it from an auth failure."""
    return httpx.Response(
        403,
        json={
            "error": {
                "code": 403,
                "errors": [{"reason": "quotaExceeded", "message": "quota exceeded"}],
            }
        },
    )


class TestAuthorizeUrl:
    def test_asks_for_offline_access_and_forces_the_consent_screen(self) -> None:
        """The two parameters that decide whether this integration survives.

        Without `access_type=offline` Google returns no refresh token at all;
        without `prompt=consent` a *repeat* authorization returns none either,
        because Google issues one only the first time an account grants a
        scope. Either omission produces an integration that works for an hour
        and then silently cannot refresh.
        """
        query = dict(parse_qsl(urlsplit(build_authorize_url(CLIENT_ID, REDIRECT_URI, "st")).query))

        assert query["access_type"] == "offline"
        assert query["prompt"] == "consent"

    def test_carries_the_state_and_the_single_read_only_scope(self) -> None:
        query = dict(parse_qsl(urlsplit(build_authorize_url(CLIENT_ID, REDIRECT_URI, "st")).query))

        assert query["state"] == "st"
        assert query["scope"] == "https://www.googleapis.com/auth/youtube.readonly"
        assert query["response_type"] == "code"
        assert query["redirect_uri"] == REDIRECT_URI


class TestTokens:
    def test_exchange_sends_the_client_secret(self, transport) -> None:
        """Google's flow is not PKCE. Spotify needs no secret and this does, so
        a copy of the Spotify exchange would fail every login."""
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(form_body(request))
            return httpx.Response(
                200,
                json={"access_token": "at", "refresh_token": "rt", "expires_in": 3600},
            )

        transport(handler)
        tokens = exchange_code(CLIENT_ID, CLIENT_SECRET, "code", REDIRECT_URI)

        assert seen["client_secret"] == CLIENT_SECRET
        assert seen["grant_type"] == "authorization_code"
        assert tokens.access_token == "at"
        assert tokens.refresh_token == "rt"

    def test_refresh_carries_the_old_refresh_token_forward(self, transport) -> None:
        """Google never returns a new one here. Without the fallback the stored
        token would be lost on the first refresh and the account would silently
        disconnect an hour after being connected."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": "fresh", "expires_in": 3600})

        transport(handler)
        tokens = refresh_token_set(CLIENT_ID, CLIENT_SECRET, "original-refresh")

        assert tokens.access_token == "fresh"
        assert tokens.refresh_token == "original-refresh"

    def test_a_response_with_no_refresh_token_is_named_not_stored(self, transport) -> None:
        """The failure `prompt=consent` exists to prevent, caught where it can
        still be understood. Storing an empty token instead would surface a week
        later as an account that cannot be refreshed and nobody could say why."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": "at", "expires_in": 3600})

        transport(handler)
        with pytest.raises(GoogleError, match="access_type=offline"):
            exchange_code(CLIENT_ID, CLIENT_SECRET, "code", REDIRECT_URI)

    def test_invalid_grant_reads_as_reconnect(self, transport) -> None:
        """What the 7-day Testing expiry looks like from here. It is
        indistinguishable from a revoked grant, and both mean reconnect."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text=json.dumps({"error": "invalid_grant"}))

        transport(handler)
        with pytest.raises(GoogleAuthError, match="7 days"):
            refresh_token_set(CLIENT_ID, CLIENT_SECRET, "stale")


class TestErrors:
    def test_a_spent_quota_is_not_an_auth_error(self, transport, sleeps) -> None:
        """Both arrive as 403 and they want opposite responses: a quota resets
        at midnight Pacific and retrying is pointless, while telling the user to
        reconnect sends them to do something that cannot help."""
        transport(lambda _request: quota_response())

        with pytest.raises(GoogleQuotaError, match="midnight Pacific"):
            list_playlists("at")

        # And it does not burn the retry budget on something time cannot fix.
        assert sleeps == []

    def test_a_plain_403_still_reads_as_authorization(self, transport) -> None:
        """The other edge. A guard proved only in one direction is satisfied
        just as well by code that never distinguishes them at all."""
        transport(lambda _request: httpx.Response(403, json={"error": {"code": 403}}))

        with pytest.raises(GoogleAuthError, match="test user"):
            list_playlists("at")

    def test_401_reads_as_reconnect(self, transport) -> None:
        transport(lambda _request: httpx.Response(401, json={"error": {"code": 401}}))

        with pytest.raises(GoogleAuthError):
            get_current_channel("at")

    def test_server_errors_are_retried_then_reported(self, transport, sleeps) -> None:
        transport(lambda _request: httpx.Response(503))

        with pytest.raises(GoogleError, match="after 3 attempts"):
            get_current_channel("at")

        assert len(sleeps) == 2


class TestChannel:
    def test_reads_the_signed_in_channel(self, transport) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert dict(parse_qsl(request.url.query.decode()))["mine"] == "true"
            return httpx.Response(
                200, json={"items": [{"id": "UC123", "snippet": {"title": "a personal channel"}}]}
            )

        transport(handler)
        channel = get_current_channel("at")

        assert channel.id == "UC123"
        assert channel.title == "a personal channel"

    def test_an_account_with_no_channel_is_named(self, transport) -> None:
        """A real state, not a fault: a Google account without a YouTube channel
        signs in perfectly well and then has nothing to import."""
        transport(lambda _request: httpx.Response(200, json={"items": []}))

        with pytest.raises(GoogleError, match="no YouTube channel"):
            get_current_channel("at")


class TestPlaylists:
    def test_lists_private_playlists_with_their_privacy(self, transport) -> None:
        """The privacy field is the reason #106 exists — a UI that cannot say
        which playlists are private is hiding the point of the feature."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "PL1",
                            "snippet": {"title": "Secret mix"},
                            "contentDetails": {"itemCount": 42},
                            "status": {"privacyStatus": "private"},
                        }
                    ]
                },
            )

        transport(handler)
        playlists = list_playlists("at")

        assert playlists[0].title == "Secret mix"
        assert playlists[0].track_count == 42
        assert playlists[0].privacy == "private"

    def test_follows_every_page(self, transport) -> None:
        """Paging is not cosmetic: a page holds 50, and the playlists this
        feature is for are the long ones."""
        pages = [
            {"items": [{"id": "PL1", "snippet": {"title": "one"}}], "nextPageToken": "second"},
            {"items": [{"id": "PL2", "snippet": {"title": "two"}}]},
        ]
        seen_tokens: list[str | None] = []

        def handler(request: httpx.Request) -> httpx.Response:
            query = dict(parse_qsl(request.url.query.decode()))
            seen_tokens.append(query.get("pageToken"))
            return httpx.Response(200, json=pages[len(seen_tokens) - 1])

        transport(handler)
        playlists = list_playlists("at")

        assert [playlist.id for playlist in playlists] == ["PL1", "PL2"]
        assert seen_tokens == [None, "second"]


class TestPlaylistItems:
    def test_skips_entries_whose_video_is_gone(self, transport) -> None:
        """Any playlist of age contains deleted and privated videos, and
        YouTube keeps the row with a placeholder title. Importing those would
        produce songs called "Deleted video" that can never be matched."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "snippet": {
                                "title": "A real song",
                                "videoOwnerChannelTitle": "An Artist",
                            },
                            "contentDetails": {"videoId": "abc"},
                        },
                        {
                            "snippet": {"title": "Deleted video"},
                            "contentDetails": {"videoId": "gone"},
                        },
                        {
                            "snippet": {"title": "Private video"},
                            "contentDetails": {"videoId": "hidden"},
                        },
                    ]
                },
            )

        transport(handler)
        tracks = fetch_all_playlist_items("at", "PL1")

        assert [track.video_id for track in tracks] == ["abc"]
        assert tracks[0].title == "A real song"
        assert tracks[0].channel_title == "An Artist"

    def test_keeps_a_track_whose_uploader_is_missing(self, transport) -> None:
        """The other edge of the same filter. `videoOwnerChannelTitle` is absent
        on some old entries, and dropping those would silently lose real songs —
        the artist is optional, the video is not."""

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "items": [
                        {"snippet": {"title": "Old upload"}, "contentDetails": {"videoId": "xyz"}}
                    ]
                },
            )

        transport(handler)
        tracks = fetch_all_playlist_items("at", "PL1")

        assert [track.video_id for track in tracks] == ["xyz"]
        assert tracks[0].channel_title is None
