import string
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlsplit

import httpx
import pytest

import app.spotify as spotify
from app.spotify import (
    SpotifyAuthError,
    SpotifyError,
    build_authorize_url,
    code_challenge_from_verifier,
    exchange_code,
    generate_pkce_pair,
    get_current_user,
    refresh_token_set,
)

# RFC 7636 appendix B test vector.
RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

VERIFIER_CHARSET = set(string.ascii_letters + string.digits + "-._~")


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Capture retry waits instead of actually sleeping."""
    recorded: list[float] = []
    monkeypatch.setattr(spotify.time, "sleep", recorded.append)
    return recorded


@pytest.fixture
def transport(monkeypatch: pytest.MonkeyPatch):
    def install(handler) -> None:
        monkeypatch.setattr(spotify, "_transport", httpx.MockTransport(handler))

    return install


def form_body(request: httpx.Request) -> dict[str, str]:
    return dict(parse_qsl(request.content.decode()))


def test_pkce_pair_is_rfc7636_compliant() -> None:
    verifier, challenge = generate_pkce_pair()

    assert 43 <= len(verifier) <= 128
    assert set(verifier) <= VERIFIER_CHARSET
    assert challenge == code_challenge_from_verifier(verifier)
    assert "=" not in challenge


def test_code_challenge_matches_rfc_vector() -> None:
    assert code_challenge_from_verifier(RFC_VERIFIER) == RFC_CHALLENGE


def test_build_authorize_url_carries_all_params() -> None:
    url = build_authorize_url(
        client_id="client-1",
        redirect_uri="http://127.0.0.1:8000/spotify/callback",
        state="state-1",
        code_challenge="challenge-1",
    )

    parts = urlsplit(url)
    params = dict(parse_qsl(parts.query))
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == spotify.AUTHORIZE_URL
    assert params == {
        "client_id": "client-1",
        "response_type": "code",
        "redirect_uri": "http://127.0.0.1:8000/spotify/callback",
        "state": "state-1",
        "scope": "playlist-read-private playlist-read-collaborative user-library-read",
        "code_challenge_method": "S256",
        "code_challenge": "challenge-1",
        "show_dialog": "true",
    }


def test_exchange_code_posts_form_and_parses_tokens(transport) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "access_token": "acc-1",
                "refresh_token": "ref-1",
                "expires_in": 3600,
                "scope": "playlist-read-private",
            },
        )

    transport(handler)
    tokens = exchange_code(
        client_id="client-1",
        code="code-1",
        redirect_uri="http://127.0.0.1:8000/spotify/callback",
        code_verifier="verifier-1",
    )

    assert str(seen[0].url) == spotify.TOKEN_URL
    assert form_body(seen[0]) == {
        "grant_type": "authorization_code",
        "code": "code-1",
        "redirect_uri": "http://127.0.0.1:8000/spotify/callback",
        "client_id": "client-1",
        "code_verifier": "verifier-1",
    }
    assert tokens.access_token == "acc-1"
    assert tokens.refresh_token == "ref-1"
    assert tokens.scopes == "playlist-read-private"
    remaining = tokens.expires_at - datetime.now(UTC)
    assert timedelta(seconds=3500) < remaining <= timedelta(seconds=3600)


def test_refresh_stores_rotated_refresh_token(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert form_body(request) == {
            "grant_type": "refresh_token",
            "refresh_token": "old-ref",
            "client_id": "client-1",
        }
        return httpx.Response(
            200, json={"access_token": "acc-2", "refresh_token": "new-ref", "expires_in": 3600}
        )

    transport(handler)
    tokens = refresh_token_set("client-1", "old-ref")

    assert tokens.access_token == "acc-2"
    assert tokens.refresh_token == "new-ref"


def test_refresh_keeps_old_token_when_none_returned(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"access_token": "acc-2", "expires_in": 3600})

    transport(handler)
    tokens = refresh_token_set("client-1", "old-ref")

    assert tokens.refresh_token == "old-ref"


def test_refresh_invalid_grant_is_an_auth_error(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant"})

    transport(handler)
    with pytest.raises(SpotifyAuthError):
        refresh_token_set("client-1", "revoked-ref")


def test_429_waits_retry_after_then_succeeds(transport, sleeps: list[float]) -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        if calls["count"] == 1:
            return httpx.Response(429, headers={"Retry-After": "7"})
        return httpx.Response(200, json={"id": "user-1", "display_name": "Alex"})

    transport(handler)
    user = get_current_user("acc-1")

    assert user.id == "user-1"
    assert sleeps == [7.0]


def test_401_raises_auth_error_without_retry(transport, sleeps: list[float]) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401)

    transport(handler)
    with pytest.raises(SpotifyAuthError):
        get_current_user("expired-token")
    assert sleeps == []


def test_403_mentions_premium_and_allowlist(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403)

    transport(handler)
    with pytest.raises(SpotifyAuthError, match="Premium|allowlist"):
        get_current_user("acc-1")


def test_server_errors_exhaust_retries(transport, sleeps: list[float]) -> None:
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(503)

    transport(handler)
    with pytest.raises(SpotifyError, match="after 3 attempts"):
        get_current_user("acc-1")
    assert calls["count"] == 3


def test_get_current_user_sends_bearer_token(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer acc-1"
        assert str(request.url) == f"{spotify.API_BASE}/me"
        return httpx.Response(200, json={"id": "user-1", "display_name": None})

    transport(handler)
    user = get_current_user("acc-1")

    assert user.id == "user-1"
    assert user.display_name is None
