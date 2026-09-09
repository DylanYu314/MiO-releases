from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import app.routers.jobs as jobs_router
import app.routers.playlist_imports as imports_router
from app.access_keys import (
    create_access_key,
    gate_active,
    hash_key,
    is_admin_key,
    is_valid_key,
    verify_access_key,
)


@pytest.fixture(autouse=True)
def _stub_enqueue(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs_router.import_job_task, "delay", lambda job_id: None)
    monkeypatch.setattr(imports_router.playlist_import_task, "delay", lambda import_id: None)


def _import(client: TestClient, headers: dict[str, str] | None = None):
    """POST a gated import entrypoint (a YouTube playlist import)."""
    return client.post(
        "/playlist-imports/youtube",
        json={"url": "https://www.youtube.com/playlist?list=PL1"},
        headers=headers,
    )


def test_create_stores_only_a_hash_and_returns_the_token(db_session: Session) -> None:
    row, token = create_access_key(db_session, "a phone")

    assert len(token) > 20  # a real random token
    assert row.key_hash == hash_key(token)
    assert row.key_hash != token  # the plaintext is never stored
    assert row.label == "a phone"


def test_verify_matches_only_the_right_active_key(db_session: Session) -> None:
    _, token = create_access_key(db_session, "x")

    assert verify_access_key(db_session, token) is True
    assert verify_access_key(db_session, "not-the-key") is False


def test_verify_records_last_used(db_session: Session) -> None:
    row, token = create_access_key(db_session, "x")
    assert row.last_used_at is None

    verify_access_key(db_session, token)

    db_session.refresh(row)
    assert row.last_used_at is not None


def test_gate_active_tracks_nonrevoked_keys(db_session: Session) -> None:
    assert gate_active(db_session) is False  # dormant until a key exists

    row, token = create_access_key(db_session, "x")
    assert gate_active(db_session) is True

    row.revoked_at = datetime.now(UTC)
    db_session.commit()
    assert gate_active(db_session) is False  # revoking the last key reopens it
    assert verify_access_key(db_session, token) is False  # and its token stops working


def test_status_is_unlocked_when_no_keys_exist(client: TestClient) -> None:
    body = client.get("/access/status").json()
    assert body == {"locked": False, "unlocked": True, "admin": False}


def test_status_reflects_the_key_once_one_exists(client: TestClient, db_session: Session) -> None:
    _, token = create_access_key(db_session, "x")

    without = client.get("/access/status").json()
    assert without == {"locked": True, "unlocked": False, "admin": False}

    wrong = client.get("/access/status", headers={"X-Unlock-Key": "nope"}).json()
    assert wrong == {"locked": True, "unlocked": False, "admin": False}

    good = client.get("/access/status", headers={"X-Unlock-Key": token}).json()
    assert good == {"locked": True, "unlocked": True, "admin": False}


def test_require_access_key_locks_even_with_no_keys(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.access_keys as access_keys

    monkeypatch.setattr(access_keys, "get_settings", lambda: _settings_with_require())

    body = client.get("/access/status").json()
    assert body == {"locked": True, "unlocked": False, "admin": False}


def _settings_with_require():
    from app.config import Settings

    return Settings(require_access_key=True)


def test_imports_are_open_while_no_keys_exist(client: TestClient) -> None:
    assert _import(client).status_code == 201


def test_imports_require_a_valid_key_once_one_exists(
    client: TestClient, db_session: Session
) -> None:
    _, token = create_access_key(db_session, "x")

    assert _import(client).status_code == 401
    assert _import(client, {"X-Unlock-Key": "wrong"}).status_code == 401
    assert _import(client, {"X-Unlock-Key": token}).status_code == 201


def test_add_a_link_is_gated_once_a_key_exists(client: TestClient, db_session: Session) -> None:
    """⚠️ Reverses ADR-009's carve-out, and the previous test asserted the
    opposite (#614).

    `POST /jobs` was left open because playlist import and search were the
    expensive things and "add a link" was the friendly path. Since #608 the
    phone fetches everything it can itself, so this is the **only** endpoint
    that still spends the server's CPU — yt-dlp plus an ffmpeg transcode — and
    a self-hosted MiO exists to serve it and almost nothing else. Leaving it
    open would gate the two things a phone never asks for and leave the
    expensive one unguarded.
    """
    _, token = create_access_key(db_session, "x")

    assert client.post("/jobs", json={"url": "https://example.com/1"}).status_code == 401
    assert (
        client.post(
            "/jobs",
            json={"url": "https://example.com/1"},
            headers={"X-Unlock-Key": "wrong"},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/jobs",
            json={"url": "https://example.com/1"},
            headers={"X-Unlock-Key": token},
        ).status_code
        == 201
    )


def test_add_a_link_stays_open_while_no_key_exists(client: TestClient) -> None:
    """The gate is dormant until the first key, so a personal instance that has
    never minted one is unaffected — which is what keeps this change from
    breaking an existing deployment on upgrade."""
    assert client.post("/jobs", json={"url": "https://example.com/1"}).status_code == 201


# --- Admin keys (#354) -----------------------------------------------------


def test_a_new_key_is_not_an_admin_key(db_session):
    """Defaulted false, and the default is the safety property.

    Every key that existed before this column was handed to a tester. None of
    them should have become an administrator by being old.
    """
    row, _ = create_access_key(db_session, "a tester's phone")

    assert row.is_admin is False


def test_an_admin_key_has_to_be_asked_for(db_session):
    row, _ = create_access_key(db_session, "a laptop", is_admin=True)

    assert row.is_admin is True


def test_is_admin_key_rejects_an_ordinary_key(db_session):
    _, token = create_access_key(db_session, "a tester's phone")

    assert is_valid_key(db_session, token) is True
    # Valid and not an administrator: the two answers are independent, which is
    # the distinction the diagnostics gate rests on.
    assert is_admin_key(db_session, token) is False


def test_is_admin_key_rejects_a_revoked_admin_key(db_session):
    row, token = create_access_key(db_session, "an old laptop", is_admin=True)
    row.revoked_at = datetime.now(UTC)
    db_session.commit()

    assert is_admin_key(db_session, token) is False


def test_is_admin_key_rejects_nothing_at_all(db_session):
    assert is_admin_key(db_session, None) is False
    assert is_admin_key(db_session, "") is False


def test_the_status_endpoint_reports_admin_separately(client: TestClient, db_session):
    """`admin` is not implied by `unlocked` — every tester is unlocked."""
    _, tester = create_access_key(db_session, "a tester's phone")
    _, mine = create_access_key(db_session, "a laptop", is_admin=True)

    as_tester = client.get("/access/status", headers={"X-Unlock-Key": tester}).json()
    as_admin = client.get("/access/status", headers={"X-Unlock-Key": mine}).json()

    assert as_tester == {"locked": True, "unlocked": True, "admin": False}
    assert as_admin == {"locked": True, "unlocked": True, "admin": True}
