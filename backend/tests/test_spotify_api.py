import time
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.routers.spotify as spotify_router
from app.config import Settings
from app.models import SpotifyAccount
from app.spotify import SpotifyAuthError, SpotifyError, SpotifyPlaylist, SpotifyUser, TokenSet


@pytest.fixture(autouse=True)
def _clear_pending_auth() -> None:
    spotify_router._pending_auth.clear()


def _settings(client_id: str | None) -> Settings:
    # All Spotify fields explicit so a developer's real backend/.env can never
    # leak into these tests (init args outrank env/dotenv in pydantic-settings).
    return Settings(
        spotify_client_id=client_id,
        spotify_redirect_uri="http://127.0.0.1:8000/spotify/callback",
        frontend_base_url="http://localhost:5173",
        spotify_app_redirect_uri="mio://add/import",
    )


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spotify_router, "get_settings", lambda: _settings("test-client-id"))


@pytest.fixture
def unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spotify_router, "get_settings", lambda: _settings(None))


def make_tokens() -> TokenSet:
    return TokenSet(
        access_token="acc-1",
        refresh_token="ref-1",
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        scopes="playlist-read-private",
    )


def seed_account(db_session: Session, spotify_user_id: str = "user-1") -> SpotifyAccount:
    account = SpotifyAccount(
        spotify_user_id=spotify_user_id,
        display_name="Alex",
        access_token="acc-1",
        refresh_token="ref-1",
        token_expires_at=datetime.now(UTC) + timedelta(hours=1),
        scopes="playlist-read-private",
    )
    db_session.add(account)
    db_session.commit()
    db_session.refresh(account)
    return account


def test_login_requires_configuration(client: TestClient, unconfigured: None) -> None:
    response = client.get("/spotify/login", follow_redirects=False)

    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


def test_login_redirects_to_spotify_and_stashes_state(client: TestClient, configured: None) -> None:
    response = client.get("/spotify/login", follow_redirects=False)

    assert response.status_code == 302
    location = urlsplit(response.headers["location"])
    assert location.netloc == "accounts.spotify.com"
    params = parse_qs(location.query)
    assert params["client_id"] == ["test-client-id"]
    assert params["code_challenge_method"] == ["S256"]
    state = params["state"][0]
    assert state in spotify_router._pending_auth


def test_callback_happy_path_stores_account_and_redirects(
    client: TestClient, configured: None, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    spotify_router._pending_auth["state-1"] = ("verifier-1", "web", time.monotonic())

    def _exchange(client_id: str, code: str, redirect_uri: str, code_verifier: str) -> TokenSet:
        assert (client_id, code, code_verifier) == ("test-client-id", "code-1", "verifier-1")
        return make_tokens()

    monkeypatch.setattr(spotify_router, "exchange_code", _exchange)
    monkeypatch.setattr(
        spotify_router, "get_current_user", lambda token: SpotifyUser("user-1", "Alex")
    )

    response = client.get("/spotify/callback?code=code-1&state=state-1", follow_redirects=False)

    assert response.status_code == 302
    account = db_session.scalars(select(SpotifyAccount)).one()
    assert account.spotify_user_id == "user-1"
    assert response.headers["location"] == f"http://localhost:5173/import?connected={account.id}"
    assert "state-1" not in spotify_router._pending_auth


def test_callback_reconnect_updates_the_same_account(
    client: TestClient, configured: None, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        spotify_router, "get_current_user", lambda token: SpotifyUser("user-1", "Alex")
    )
    for attempt in (1, 2):
        spotify_router._pending_auth[f"state-{attempt}"] = ("verifier", "web", time.monotonic())
        monkeypatch.setattr(spotify_router, "exchange_code", lambda *a, **k: make_tokens())
        client.get(f"/spotify/callback?code=c&state=state-{attempt}", follow_redirects=False)

    rows = db_session.scalars(select(SpotifyAccount)).all()
    assert len(rows) == 1


class TestTheAndroidClientComesBackToTheApp:
    """?client=app sends the callback to a deep link instead of the web app (#203).

    Spotify carries nothing of ours through the round trip except `state`, so
    the choice has to be remembered here — which is why these assert on the
    *stash* as well as on the redirect.
    """

    def test_login_records_which_client_started_it(
        self, client: TestClient, configured: None
    ) -> None:
        response = client.get("/spotify/login?client=app", follow_redirects=False)

        state = parse_qs(urlsplit(response.headers["location"]).query)["state"][0]
        assert spotify_router._pending_auth[state][1] == "app"

    def test_web_is_the_default_so_the_web_client_needs_no_change(
        self, client: TestClient, configured: None
    ) -> None:
        response = client.get("/spotify/login", follow_redirects=False)

        state = parse_qs(urlsplit(response.headers["location"]).query)["state"][0]
        assert spotify_router._pending_auth[state][1] == "web"

    def test_anything_other_than_the_two_names_is_refused(
        self, client: TestClient, configured: None
    ) -> None:
        # The whole point of an enum here: a free-text destination would be an
        # open redirect carrying an OAuth code.
        response = client.get("/spotify/login?client=https://evil.example", follow_redirects=False)

        assert response.status_code == 422

    def test_success_returns_to_the_deep_link(
        self,
        client: TestClient,
        configured: None,
        db_session: Session,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        spotify_router._pending_auth["state-1"] = ("verifier-1", "app", time.monotonic())
        monkeypatch.setattr(spotify_router, "exchange_code", lambda **kwargs: make_tokens())
        monkeypatch.setattr(
            spotify_router, "get_current_user", lambda token: SpotifyUser("user-1", "Alex")
        )

        response = client.get("/spotify/callback?code=code-1&state=state-1", follow_redirects=False)

        account = db_session.scalars(select(SpotifyAccount)).one()
        assert response.headers["location"] == f"mio://add/import?connected={account.id}"

    def test_failure_returns_to_the_deep_link_too(
        self, client: TestClient, configured: None, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # An error that lands on the web client is an error the phone never
        # sees — the browser would sit on a page the user did not ask for.
        spotify_router._pending_auth["state-1"] = ("verifier-1", "app", time.monotonic())
        monkeypatch.setattr(
            spotify_router,
            "exchange_code",
            lambda **kwargs: (_ for _ in ()).throw(SpotifyError("nope")),
        )

        response = client.get("/spotify/callback?code=code-1&state=state-1", follow_redirects=False)

        assert response.headers["location"] == "mio://add/import?spotify_error=exchange_failed"

    def test_an_unknown_state_falls_back_to_the_web_client(
        self, client: TestClient, configured: None
    ) -> None:
        # Nothing records who started it, so there is nothing to honour.
        # Guessing "app" would send a *browser* to a scheme it cannot open, and
        # the error would vanish rather than being shown.
        response = client.get("/spotify/callback?code=c&state=forged", follow_redirects=False)

        assert response.headers["location"].startswith("http://localhost:5173/")


def test_callback_user_denial_redirects_with_error_slug(
    client: TestClient, configured: None
) -> None:
    response = client.get(
        "/spotify/callback?error=access_denied&state=whatever", follow_redirects=False
    )

    assert response.status_code == 302
    assert response.headers["location"].endswith("/import?spotify_error=access_denied")


def test_callback_unknown_state_is_rejected(client: TestClient, configured: None) -> None:
    response = client.get("/spotify/callback?code=c&state=forged", follow_redirects=False)

    assert response.headers["location"].endswith("/import?spotify_error=state_mismatch")


def test_callback_expired_state_is_rejected(client: TestClient, configured: None) -> None:
    expired_at = time.monotonic() - spotify_router.PENDING_AUTH_TTL - 1
    spotify_router._pending_auth["state-old"] = ("verifier", "web", expired_at)

    response = client.get("/spotify/callback?code=c&state=state-old", follow_redirects=False)

    assert response.headers["location"].endswith("/import?spotify_error=state_mismatch")


def test_callback_exchange_failure_redirects_not_500(
    client: TestClient, configured: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    spotify_router._pending_auth["state-1"] = ("verifier-1", "web", time.monotonic())

    def _boom(*args: object, **kwargs: object) -> TokenSet:
        raise SpotifyError("token endpoint unreachable")

    monkeypatch.setattr(spotify_router, "exchange_code", _boom)

    response = client.get("/spotify/callback?code=code-1&state=state-1", follow_redirects=False)

    assert response.status_code == 302
    assert response.headers["location"].endswith("/import?spotify_error=exchange_failed")


def test_status_reports_unconfigured(client: TestClient, unconfigured: None) -> None:
    response = client.get("/spotify/status")

    assert response.status_code == 200
    assert response.json() == {"configured": False, "accounts": []}


def test_status_lists_connected_accounts(
    client: TestClient, configured: None, db_session: Session
) -> None:
    account = seed_account(db_session)

    body = client.get("/spotify/status").json()

    assert body["configured"] is True
    assert [a["id"] for a in body["accounts"]] == [account.id]
    assert body["accounts"][0]["display_name"] == "Alex"
    assert "access_token" not in body["accounts"][0]


def test_playlists_proxy_returns_a_page(
    client: TestClient, configured: None, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    account = seed_account(db_session)
    monkeypatch.setattr(spotify_router, "get_fresh_access_token", lambda db, acc, client_id: "tok")
    monkeypatch.setattr(
        spotify_router,
        "list_playlists",
        lambda token, limit, offset: (
            [
                SpotifyPlaylist(
                    id="pl-1",
                    name="Road Trip",
                    image_url=None,
                    track_count=12,
                    owner_name="Alex",
                )
            ],
            37,
        ),
    )

    body = client.get(f"/spotify/playlists?account_id={account.id}").json()

    assert body["total"] == 37
    assert body["items"][0] == {
        "id": "pl-1",
        "name": "Road Trip",
        "image_url": None,
        "track_count": 12,
        "owner_name": "Alex",
    }


def test_playlists_proxy_maps_auth_errors_to_502(
    client: TestClient, configured: None, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    account = seed_account(db_session)

    def _fail(db: Session, acc: SpotifyAccount, client_id: str) -> str:
        raise SpotifyAuthError("Spotify rejected the request (403) — Premium may have lapsed")

    monkeypatch.setattr(spotify_router, "get_fresh_access_token", _fail)

    response = client.get(f"/spotify/playlists?account_id={account.id}")

    assert response.status_code == 502
    assert "Premium" in response.json()["detail"]


def test_playlists_proxy_reports_generic_errors_as_unavailable(
    client: TestClient, configured: None, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    account = seed_account(db_session)
    monkeypatch.setattr(spotify_router, "get_fresh_access_token", lambda db, acc, client_id: "tok")

    def _fail(token: str, limit: int, offset: int) -> tuple:
        raise SpotifyError("boom")

    monkeypatch.setattr(spotify_router, "list_playlists", _fail)

    response = client.get(f"/spotify/playlists?account_id={account.id}")

    assert response.status_code == 502
    assert response.json()["detail"] == "Spotify connection unavailable — try again later"


def test_playlists_proxy_unknown_account_is_404(client: TestClient, configured: None) -> None:
    assert client.get("/spotify/playlists?account_id=999").status_code == 404


def test_playlists_proxy_requires_configuration(client: TestClient, unconfigured: None) -> None:
    assert client.get("/spotify/playlists?account_id=1").status_code == 503


def test_disconnect_works_even_unconfigured(
    client: TestClient, unconfigured: None, db_session: Session
) -> None:
    account = seed_account(db_session)

    response = client.delete(f"/spotify/accounts/{account.id}")

    assert response.status_code == 204
    assert db_session.scalars(select(SpotifyAccount)).all() == []
    assert client.delete(f"/spotify/accounts/{account.id}").status_code == 404
