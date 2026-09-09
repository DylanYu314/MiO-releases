from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import app.routers.google as google_router
from app.access_keys import create_access_key
from app.config import Settings, get_settings
from app.google import (
    GoogleAuthError,
    GoogleChannel,
    GoogleError,
    GooglePlaylist,
    GoogleQuotaError,
    GoogleTrack,
    TokenSet,
)
from app.google_accounts import upsert_account
from app.main import app

CHANNEL = GoogleChannel(id="UC123", title="a personal channel")


def tokens() -> TokenSet:
    return TokenSet(
        access_token="at",
        refresh_token="rt",
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        scopes="https://www.googleapis.com/auth/youtube.readonly",
    )


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch):
    """A server that has Google credentials.

    Overridden through `get_settings`, which is `lru_cache`d and read at import
    time — the same reason `.env` edits need a restart in real life.
    """
    settings = Settings(
        google_client_id="client-id",
        google_client_secret="GOCSPX-secret",
        google_redirect_uri="http://localhost:8000/google/callback",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    monkeypatch.setattr(google_router, "get_settings", lambda: settings)
    yield settings
    app.dependency_overrides.pop(get_settings, None)


@pytest.fixture
def connected(db_session: Session, configured):
    return upsert_account(db_session, tokens(), CHANNEL)


class TestStatus:
    def test_says_when_the_server_has_no_credentials(self, client: TestClient) -> None:
        """The state the client renders differently from "nobody has connected".

        Collapsing the two would tell a user to connect an account on a server
        that cannot possibly complete the flow.
        """
        body = client.get("/google/status").json()

        assert body["configured"] is False
        assert body["channel_title"] is None

    def test_says_configured_but_unconnected(self, client: TestClient, configured) -> None:
        body = client.get("/google/status").json()

        assert body["configured"] is True
        assert body["channel_id"] is None

    def test_names_the_connected_channel(self, client: TestClient, connected) -> None:
        body = client.get("/google/status").json()

        assert body["configured"] is True
        assert body["channel_title"] == "a personal channel"

    def test_works_without_credentials_so_the_screen_can_explain_itself(
        self, client: TestClient
    ) -> None:
        """Ungated and unconfigured-safe on purpose: a 503 here would leave the
        UI unable to say why the feature is unavailable."""
        assert client.get("/google/status").status_code == 200


class TestUnconfigured:
    def test_login_answers_503_rather_than_a_broken_redirect(self, client: TestClient) -> None:
        assert client.get("/google/login", follow_redirects=False).status_code == 503

    def test_playlists_answer_503(self, client: TestClient) -> None:
        assert client.get("/google/playlists").status_code == 503


class TestLogin:
    def test_bounces_to_google_with_offline_access(self, client: TestClient, configured) -> None:
        response = client.get("/google/login", follow_redirects=False)

        assert response.status_code == 302
        query = dict(parse_qsl(urlsplit(response.headers["location"]).query))
        assert query["access_type"] == "offline"
        assert query["prompt"] == "consent"
        assert query["state"]


class TestCallback:
    def test_stores_the_account_and_returns_to_the_web_client(
        self, client: TestClient, configured, monkeypatch: pytest.MonkeyPatch, db_session: Session
    ) -> None:
        monkeypatch.setattr(google_router, "exchange_code", lambda *_: tokens())
        monkeypatch.setattr(google_router, "get_current_channel", lambda _: CHANNEL)

        state = dict(
            parse_qsl(
                urlsplit(
                    client.get("/google/login", follow_redirects=False).headers["location"]
                ).query
            )
        )["state"]
        response = client.get(f"/google/callback?code=abc&state={state}", follow_redirects=False)

        assert response.status_code == 302
        assert "connected=google" in response.headers["location"]
        assert client.get("/google/status").json()["channel_title"] == "a personal channel"

    def test_an_unknown_state_is_refused(self, client: TestClient, configured) -> None:
        """The CSRF check. A callback carrying a state this server never issued
        is not one of ours, and must not be exchanged."""
        response = client.get(
            "/google/callback?code=abc&state=never-issued", follow_redirects=False
        )

        assert "google_error=state_mismatch" in response.headers["location"]

    def test_a_refused_consent_comes_back_as_a_named_error(
        self, client: TestClient, configured
    ) -> None:
        response = client.get("/google/callback?error=access_denied", follow_redirects=False)

        assert "google_error=access_denied" in response.headers["location"]

    def test_the_app_client_gets_the_deep_link_back(
        self, client: TestClient, configured, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A browser sent to the web client would strand an Android user on a
        page they did not start from."""
        monkeypatch.setattr(google_router, "exchange_code", lambda *_: tokens())
        monkeypatch.setattr(google_router, "get_current_channel", lambda _: CHANNEL)

        state = dict(
            parse_qsl(
                urlsplit(
                    client.get("/google/login?client=app", follow_redirects=False).headers[
                        "location"
                    ]
                ).query
            )
        )["state"]
        response = client.get(f"/google/callback?code=abc&state={state}", follow_redirects=False)

        assert response.headers["location"].startswith("mio://")

    def test_an_account_with_no_channel_does_not_connect(
        self, client: TestClient, configured, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A real state, not a fault — and one the user can only fix on YouTube.
        It must not leave a half-connected account behind."""
        monkeypatch.setattr(google_router, "exchange_code", lambda *_: tokens())

        def no_channel(_token: str) -> GoogleChannel:
            raise GoogleError("this Google account has no YouTube channel")

        monkeypatch.setattr(google_router, "get_current_channel", no_channel)

        state = dict(
            parse_qsl(
                urlsplit(
                    client.get("/google/login", follow_redirects=False).headers["location"]
                ).query
            )
        )["state"]
        response = client.get(f"/google/callback?code=abc&state={state}", follow_redirects=False)

        assert "google_error=exchange_failed" in response.headers["location"]
        assert client.get("/google/status").json()["channel_id"] is None


class TestPlaylists:
    def test_lists_them_with_privacy(
        self, client: TestClient, connected, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            google_router,
            "list_playlists",
            lambda _token: [
                GooglePlaylist(id="PL1", title="Secret", track_count=3, privacy="private")
            ],
        )

        body = client.get("/google/playlists").json()

        assert body == [{"id": "PL1", "title": "Secret", "track_count": 3, "privacy": "private"}]

    def test_404_when_nothing_is_connected(self, client: TestClient, configured) -> None:
        assert client.get("/google/playlists").status_code == 404

    def test_a_spent_quota_is_429_not_502(
        self, client: TestClient, connected, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The one failure waiting fixes. 502 would say "the connection is
        broken", which is false and points the user at nothing."""

        def spent(_token: str):
            raise GoogleQuotaError("quota spent")

        monkeypatch.setattr(google_router, "list_playlists", spent)

        assert client.get("/google/playlists").status_code == 429

    def test_a_dead_authorization_is_401_not_502(
        self, client: TestClient, connected, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """What the 7-day Testing expiry looks like to a client. The user has
        something to do about it — reconnect — so it is not a bad gateway."""

        def revoked(_token: str):
            raise GoogleAuthError("invalid_grant")

        monkeypatch.setattr(google_router, "list_playlists", revoked)

        assert client.get("/google/playlists").status_code == 401

    def test_a_dead_authorization_says_which_401_it_is(
        self, client: TestClient, connected, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise the weekly expiry is indistinguishable from a bad key.

        The access-key gate answers 401 on this same endpoint and asks for the
        opposite thing — *add your key* rather than *reconnect the account* —
        so a client with only the status to go on has to guess, every 7 days.
        """

        def revoked(_token: str):
            raise GoogleAuthError("invalid_grant")

        monkeypatch.setattr(google_router, "list_playlists", revoked)

        assert client.get("/google/playlists").json()["detail"]["code"] == "google_reauth"

    def test_the_access_key_gate_does_not_claim_to_be_a_google_expiry(
        self, client: TestClient, connected, db_session: Session
    ) -> None:
        """The other edge, which is what makes the code above worth reading.

        A guard proved only on the side it fires for is a guard that a broken
        implementation satisfies exactly as well (#392) — "every 401 carries the
        code" would pass the test above and tell every locked-out tester to
        reconnect their YouTube account.
        """
        create_access_key(db_session, "someone else's phone")  # arms the gate

        response = client.get("/google/playlists")

        assert response.status_code == 401
        assert response.json()["detail"] != {"code": "google_reauth", "message": "invalid_grant"}
        assert "google_reauth" not in response.text


class TestItems:
    def test_returns_video_ids_for_the_device_to_fetch(
        self, client: TestClient, connected, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The whole handover: ids, not audio. The server queues no job and
        never touches the bytes — the phone downloads each one itself (#246)."""
        monkeypatch.setattr(
            google_router,
            "fetch_all_playlist_items",
            lambda _token, _playlist: [
                GoogleTrack(video_id="abc", title="A song", channel_title="An Artist")
            ],
        )

        body = client.get("/google/playlists/PL1/items").json()

        assert body == [{"video_id": "abc", "title": "A song", "channel_title": "An Artist"}]


class TestDisconnect:
    def test_forgets_the_account(self, client: TestClient, connected) -> None:
        assert client.delete("/google/account").status_code == 204
        assert client.get("/google/status").json()["channel_id"] is None

    def test_404_when_there_is_nothing_to_disconnect(self, client: TestClient) -> None:
        assert client.delete("/google/account").status_code == 404
