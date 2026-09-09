from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.spotify_accounts as spotify_accounts
from app.models import SpotifyAccount
from app.spotify import SpotifyUser, TokenSet
from app.spotify_accounts import get_fresh_access_token, upsert_account


def make_tokens(access: str = "acc-1", refresh: str = "ref-1") -> TokenSet:
    return TokenSet(
        access_token=access,
        refresh_token=refresh,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
        scopes="playlist-read-private",
    )


def test_upsert_creates_account(db_session: Session) -> None:
    account = upsert_account(db_session, make_tokens(), SpotifyUser("user-1", "Alex"))

    assert account.id is not None
    assert account.spotify_user_id == "user-1"
    assert account.display_name == "Alex"
    assert account.access_token == "acc-1"


def test_upsert_updates_existing_account_instead_of_duplicating(db_session: Session) -> None:
    first = upsert_account(db_session, make_tokens(), SpotifyUser("user-1", "Alex"))
    second = upsert_account(
        db_session, make_tokens(access="acc-2", refresh="ref-2"), SpotifyUser("user-1", "D.")
    )

    assert second.id == first.id
    rows = db_session.scalars(select(SpotifyAccount)).all()
    assert len(rows) == 1
    assert rows[0].access_token == "acc-2"
    assert rows[0].refresh_token == "ref-2"
    assert rows[0].display_name == "D."


def test_fresh_token_is_returned_without_refreshing(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    account = upsert_account(db_session, make_tokens(), SpotifyUser("user-1", None))

    def _fail(*args: object) -> TokenSet:
        raise AssertionError("a still-valid token must not be refreshed")

    monkeypatch.setattr(spotify_accounts, "refresh_token_set", _fail)

    assert get_fresh_access_token(db_session, account, "client-1") == "acc-1"


def test_stale_token_is_refreshed_and_persisted(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    account = upsert_account(db_session, make_tokens(), SpotifyUser("user-1", None))
    account.token_expires_at = datetime.now(UTC) - timedelta(minutes=5)
    db_session.commit()

    def _refresh(client_id: str, refresh_token: str) -> TokenSet:
        assert client_id == "client-1"
        assert refresh_token == "ref-1"
        return make_tokens(access="acc-new", refresh="ref-new")

    monkeypatch.setattr(spotify_accounts, "refresh_token_set", _refresh)

    assert get_fresh_access_token(db_session, account, "client-1") == "acc-new"

    db_session.expire_all()
    stored = db_session.scalars(select(SpotifyAccount)).one()
    assert stored.access_token == "acc-new"
    assert stored.refresh_token == "ref-new"
