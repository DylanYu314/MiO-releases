from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.google_accounts as accounts
from app.google import GoogleAuthError, GoogleChannel, TokenSet
from app.google_accounts import (
    delete_account,
    get_account,
    get_fresh_access_token,
    upsert_account,
)
from app.models import GoogleAccount

CLIENT_ID = "client-id"
CLIENT_SECRET = "GOCSPX-secret"

CHANNEL = GoogleChannel(id="UC123", title="a personal channel")


def tokens(access: str = "at", refresh: str = "rt", *, expires_in: int = 3600) -> TokenSet:
    return TokenSet(
        access_token=access,
        refresh_token=refresh,
        expires_at=datetime.now(UTC) + timedelta(seconds=expires_in),
        scopes="https://www.googleapis.com/auth/youtube.readonly",
    )


class TestUpsert:
    def test_stores_a_new_login(self, db_session: Session) -> None:
        account = upsert_account(db_session, tokens(), CHANNEL)

        assert account.channel_id == "UC123"
        assert account.channel_title == "a personal channel"
        assert account.access_token == "at"
        assert account.refresh_token == "rt"

    def test_reconnecting_updates_the_same_row(self, db_session: Session) -> None:
        """The one that matters weekly.

        While the consent screen is in Testing, Google expires the refresh token
        every **7 days** and the account has to be reconnected. Keyed on the
        channel, that updates one row; keyed on anything else it would add a new
        account every week until the table is a log of reconnections.
        """
        upsert_account(db_session, tokens("old", "old-refresh"), CHANNEL)
        upsert_account(db_session, tokens("new", "new-refresh"), CHANNEL)

        rows = db_session.scalars(select(GoogleAccount)).all()
        assert len(rows) == 1
        assert rows[0].access_token == "new"
        assert rows[0].refresh_token == "new-refresh"

    def test_a_different_channel_is_a_different_account(self, db_session: Session) -> None:
        """The other edge. Without it the test above would pass on code that
        overwrote whichever row it found first."""
        upsert_account(db_session, tokens(), CHANNEL)
        upsert_account(db_session, tokens(), GoogleChannel(id="UC999", title="Another"))

        assert len(db_session.scalars(select(GoogleAccount)).all()) == 2


class TestGetAndDelete:
    def test_nothing_connected_is_none_not_an_error(self, db_session: Session) -> None:
        assert get_account(db_session) is None

    def test_returns_the_connected_account(self, db_session: Session) -> None:
        upsert_account(db_session, tokens(), CHANNEL)

        found = get_account(db_session)

        assert found is not None
        assert found.channel_id == "UC123"

    def test_delete_disconnects(self, db_session: Session) -> None:
        account = upsert_account(db_session, tokens(), CHANNEL)

        delete_account(db_session, account)

        assert get_account(db_session) is None


class TestFreshToken:
    def test_a_valid_token_is_used_as_is(
        self, db_session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """No network call for a token that is still good — a refresh per
        request would spend Google's rate limit on nothing."""

        def refuse(*_args: object, **_kwargs: object) -> TokenSet:
            raise AssertionError("should not have refreshed a valid token")

        monkeypatch.setattr(accounts, "refresh_token_set", refuse)
        account = upsert_account(db_session, tokens(expires_in=3600), CHANNEL)

        assert get_fresh_access_token(db_session, account, CLIENT_ID, CLIENT_SECRET) == "at"

    def test_an_expiring_token_is_refreshed_and_persisted(
        self, db_session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Persisted, not just returned: a refresh that is not written down is
        one network call per request for the life of the process."""
        monkeypatch.setattr(
            accounts, "refresh_token_set", lambda *_: tokens("refreshed", "rt", expires_in=3600)
        )
        # Inside the skew window: still valid by the clock, and treated as stale
        # so it cannot expire between the check and the request that uses it.
        account = upsert_account(db_session, tokens(expires_in=30), CHANNEL)

        assert get_fresh_access_token(db_session, account, CLIENT_ID, CLIENT_SECRET) == "refreshed"

        db_session.expire_all()
        assert db_session.scalar(select(GoogleAccount)).access_token == "refreshed"

    def test_a_dead_authorization_surfaces_rather_than_returning_a_stale_token(
        self, db_session: Session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """What the 7-day expiry does when it arrives. Swallowing it and handing
        back the old token would turn "reconnect the account" into a string of
        401s from the API with nothing pointing at the cause."""

        def revoked(*_args: object, **_kwargs: object) -> TokenSet:
            raise GoogleAuthError("invalid_grant")

        monkeypatch.setattr(accounts, "refresh_token_set", revoked)
        account = upsert_account(db_session, tokens(expires_in=0), CHANNEL)

        with pytest.raises(GoogleAuthError):
            get_fresh_access_token(db_session, account, CLIENT_ID, CLIENT_SECRET)
