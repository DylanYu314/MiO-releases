"""Crash reports from the clients (P9, #136)."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.access_keys import create_access_key
from app.config import Settings
from app.installs import hash_token
from app.models import ClientError, Install
from app.routers import client_errors as client_errors_router


@pytest.fixture
def admin(db_session) -> dict[str, str]:
    """Headers for a key that may read diagnostics (#354).

    Reading is admin-only and, unlike the import gate, **not dormant**: with no
    keys at all it is closed, because "nobody has set up a key yet" must not
    mean "everyone may read the crash reports". So every read in this file needs
    one, which is the fixture rather than fifteen inline headers.
    """
    _, token = create_access_key(db_session, "a laptop", is_admin=True)
    return {"X-Unlock-Key": token}


def test_a_client_can_report_a_crash(client: TestClient):
    response = client.post(
        "/client-errors",
        json={
            "platform": "android",
            "message": "TypeError: undefined is not an object",
            "stack": "at PlayerHost (PlayerHost.tsx:42)",
            "description": "I pressed play on the second song",
            "app_version": "1.0.0",
            "os_version": "Android 14",
            "device": "Pixel 7",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["platform"] == "android"
    # The field a person actually wrote, and usually the most useful one.
    assert body["description"] == "I pressed play on the second song"


def test_a_report_needs_no_key_and_no_install(client: TestClient):
    """Ungated on purpose.

    A client that crashes *during setup* — before it has a key or an identity —
    is exactly the case worth hearing about. A gate would silently drop the
    reports that matter most.
    """
    response = client.post(
        "/client-errors",
        json={"platform": "web", "message": "boom"},
    )

    assert response.status_code == 201


def test_everything_except_platform_and_message_is_optional(client: TestClient):
    """A crashing client is by definition in a bad state.

    A report rejected for missing its OS version is worth less than a partial
    one that arrives.
    """
    response = client.post("/client-errors", json={"platform": "web", "message": "boom"})

    assert response.status_code == 201
    body = response.json()
    assert body["stack"] is None
    assert body["app_version"] is None


def test_an_empty_message_is_rejected(client: TestClient):
    # A row saying only "something happened on android" is not worth storing.
    response = client.post("/client-errors", json={"platform": "web", "message": ""})

    assert response.status_code == 422


def test_an_oversized_stack_is_rejected(client: TestClient):
    response = client.post(
        "/client-errors",
        json={"platform": "web", "message": "boom", "stack": "x" * 20_001},
    )

    assert response.status_code == 422


def test_the_install_is_recorded_when_the_client_has_one(client: TestClient, db_session):
    """So several reports from one device can be tied together while a bug is
    being chased."""
    install = Install(token_hash=hash_token("a-known-install-token"))
    db_session.add(install)
    db_session.commit()
    db_session.refresh(install)

    client.post(
        "/client-errors",
        json={"platform": "android", "message": "boom"},
        headers={"X-Install-Id": "a-known-install-token"},
    )

    row = db_session.query(ClientError).order_by(ClientError.id.desc()).first()
    assert row is not None
    assert row.owner_install_id == install.id


def test_reports_are_listed_newest_first(client: TestClient, admin):
    """Read by a person looking for what just broke.

    Written strictly on purpose (#297). It used to assert a *slice* of the list
    against `total >= 3`, which tolerated rows arriving from anywhere — so if
    anything ever leaked into the table, this failed as a mysterious ordering
    mismatch rather than as "there are four rows here and there should be
    three". A test that tolerates unknown extra rows while asserting an
    order-sensitive slice cannot say what went wrong.

    The posts are checked too. Three unasserted writes followed by an assertion
    about their order is a test that reports a *symptom* of a failed write, and
    it took a while to rule that out as the cause of the flake.
    """
    # The table starts empty, and saying so is the point: `_clean_schema` drops
    # and recreates it per test, and this test's assertion only means anything
    # if that held. A leak now fails *here*, naming itself, rather than three
    # lines down as an inexplicable ordering mismatch.
    assert client.get("/client-errors", headers=admin).json()["total"] == 0

    for message in ["first", "second", "third"]:
        response = client.post("/client-errors", json={"platform": "web", "message": message})
        assert response.status_code == 201, response.text

    body = client.get("/client-errors", headers=admin).json()

    assert body["total"] == 3
    assert [item["message"] for item in body["items"]] == ["third", "second", "first"]


def test_reports_arriving_in_the_same_instant_keep_a_stable_order(
    client: TestClient, db_session, admin
):
    """The `id` tiebreak in the list query, which nothing covered (#297).

    Reports sharing a timestamp is the **normal** case, not a corner one: a
    crashing client sends a burst. Ordering on the timestamp alone leaves those
    rows in whatever order SQLite feels like, so a paginated read can show one
    row twice and miss another.

    Written with the timestamp forced rather than by posting quickly, because
    posting quickly does not reliably collide — `_utcnow()` has microsecond
    resolution, which is why the ordinary test above never exercised this and a
    mutation removing the tiebreak passed.
    """
    same_instant = datetime(2026, 8, 2, 12, 0, 0, tzinfo=UTC)
    for message in ["first", "second", "third"]:
        db_session.add(ClientError(platform="web", message=message, created_at=same_instant))
    db_session.commit()

    body = client.get("/client-errors", headers=admin).json()

    # Highest id first: within one instant, "newest" can only mean "inserted
    # last".
    assert [item["message"] for item in body["items"]] == ["third", "second", "first"]


# --- The rolling log, uploaded in a batch (#322) ---------------------------
#
# The table stopped being crashes-only: the phone keeps its own log and sends a
# day of it at a time. Two things make that safe — a level, so a few hundred
# routine lines cannot bury three crashes, and a dedupe key, so the device can
# clear its log only after an acknowledgement and still retry safely.


def _entry(key: str, **overrides) -> dict:
    entry = {
        "platform": "android",
        "message": f"entry {key}",
        "level": "info",
        "client_key": key,
    }
    entry.update(overrides)
    return entry


def test_a_batch_stores_every_entry(client: TestClient, admin):
    response = client.post(
        "/client-errors/batch",
        json={"items": [_entry("a"), _entry("b"), _entry("c")]},
    )

    assert response.status_code == 200
    assert response.json() == {"stored": 3, "duplicates": 0}
    assert client.get("/client-errors", headers=admin).json()["total"] == 3


def test_resending_a_batch_stores_nothing_twice(client: TestClient, admin):
    """The whole reason `client_key` exists.

    The device clears its log only once the server has acknowledged, so a reply
    lost in transit means the *same* entries arrive again. That has to be a
    no-op rather than a second copy.
    """
    items = [_entry("a"), _entry("b")]
    client.post("/client-errors/batch", json={"items": items})

    response = client.post("/client-errors/batch", json={"items": items})

    assert response.status_code == 200
    assert response.json() == {"stored": 0, "duplicates": 2}
    assert client.get("/client-errors", headers=admin).json()["total"] == 2


def test_a_partly_seen_batch_keeps_the_entries_that_are_new(client: TestClient, admin):
    """The reason dedupe reads the keys instead of catching an IntegrityError.

    On SQLite one conflicting row inside a flush aborts the whole transaction,
    so the exception-driven version would lose every good entry that shared the
    request with a repeat — which is the normal shape of a retry, because the
    device keeps logging while the first upload is in flight.
    """
    client.post("/client-errors/batch", json={"items": [_entry("a")]})

    response = client.post(
        "/client-errors/batch",
        json={"items": [_entry("a"), _entry("b"), _entry("c")]},
    )

    assert response.json() == {"stored": 2, "duplicates": 1}
    messages = {
        item["message"] for item in client.get("/client-errors", headers=admin).json()["items"]
    }
    assert messages == {"entry a", "entry b", "entry c"}


def test_a_key_repeated_inside_one_batch_is_stored_once(client: TestClient, admin):
    """The read of existing keys cannot see a collision within the request.

    Left to the UNIQUE index it would be a 500 at flush time, losing the whole
    upload — and a device that logs the same event twice in a second is not
    misbehaving.
    """
    response = client.post(
        "/client-errors/batch",
        json={"items": [_entry("a"), _entry("a")]},
    )

    assert response.json() == {"stored": 1, "duplicates": 1}
    assert client.get("/client-errors", headers=admin).json()["total"] == 1


def test_an_empty_batch_is_rejected(client: TestClient):
    response = client.post("/client-errors/batch", json={"items": []})

    assert response.status_code == 422


def test_an_oversized_batch_is_rejected(client: TestClient):
    """Capped at the device's own log ceiling: more than a full log is not ours."""
    response = client.post(
        "/client-errors/batch",
        json={"items": [_entry(str(n)) for n in range(501)]},
    )

    assert response.status_code == 422


def test_the_batch_records_the_install_when_the_client_has_one(
    client: TestClient, db_session, install_id: int
):
    client.post("/client-errors/batch", json={"items": [_entry("a")]})

    row = db_session.query(ClientError).one()
    assert row.owner_install_id == install_id


def test_a_crash_report_still_needs_no_key_of_its_own(client: TestClient, admin):
    """The single-report path mints no `client_key`, and must not have to.

    It fires once from a client that may be seconds from being killed. SQLite's
    UNIQUE ignores NULLs, so any number of those coexist — this is the test that
    a NOT NULL column would have broken.
    """
    for _ in range(3):
        assert (
            client.post("/client-errors", json={"platform": "web", "message": "boom"}).status_code
            == 201
        )

    assert client.get("/client-errors", headers=admin).json()["total"] == 3


def test_a_report_without_a_level_reads_as_an_error(client: TestClient):
    """A client written against the pre-#322 endpoint keeps working unchanged."""
    body = client.post("/client-errors", json={"platform": "web", "message": "boom"}).json()

    assert body["level"] == "error"


def test_the_list_can_be_narrowed_to_one_level(client: TestClient, admin):
    """A day of one phone's log buries the crashes in it."""
    client.post(
        "/client-errors/batch",
        json={
            "items": [
                _entry("a", level="info"),
                _entry("b", level="error", message="it broke"),
                _entry("c", level="info"),
            ]
        },
    )

    body = client.get("/client-errors", headers=admin, params={"level": "error"}).json()

    assert body["total"] == 1
    assert [item["message"] for item in body["items"]] == ["it broke"]


# --- Retention (#322) ------------------------------------------------------
#
# This is the one table in the schema that grows on its own: an ungated endpoint
# writes to it, every device adds a day of log daily, and nothing deletes.


def _retention(days: int) -> Settings:
    return Settings(client_error_retention_days=days)


def test_a_batch_sweeps_rows_past_the_retention_window(
    client: TestClient, db_session, monkeypatch, admin
):
    monkeypatch.setattr(client_errors_router, "get_settings", lambda: _retention(30))
    db_session.add(
        ClientError(
            platform="android",
            message="ancient",
            created_at=datetime.now(UTC) - timedelta(days=31),
        )
    )
    db_session.commit()

    client.post("/client-errors/batch", json={"items": [_entry("a")]})

    messages = [
        item["message"] for item in client.get("/client-errors", headers=admin).json()["items"]
    ]
    assert messages == ["entry a"]


def test_the_sweep_keeps_rows_inside_the_window(client: TestClient, db_session, monkeypatch, admin):
    """The assertion that makes the one above mean something.

    Without this a sweep that deleted the whole table would pass the test
    before it.
    """
    monkeypatch.setattr(client_errors_router, "get_settings", lambda: _retention(30))
    db_session.add(
        ClientError(
            platform="android",
            message="recent",
            created_at=datetime.now(UTC) - timedelta(days=29),
        )
    )
    db_session.commit()

    client.post("/client-errors/batch", json={"items": [_entry("a")]})

    messages = {
        item["message"] for item in client.get("/client-errors", headers=admin).json()["items"]
    }
    assert messages == {"recent", "entry a"}


def test_retention_can_be_switched_off(client: TestClient, db_session, monkeypatch, admin):
    """0 means keep everything — an escape hatch for chasing an old bug."""
    monkeypatch.setattr(client_errors_router, "get_settings", lambda: _retention(0))
    db_session.add(
        ClientError(
            platform="android",
            message="ancient",
            created_at=datetime.now(UTC) - timedelta(days=400),
        )
    )
    db_session.commit()

    client.post("/client-errors/batch", json={"items": [_entry("a")]})

    assert client.get("/client-errors", headers=admin).json()["total"] == 2


def test_the_startup_sweep_runs_on_its_own_session(db_session, monkeypatch):
    """A server nobody has uploaded to for months would otherwise never sweep.

    The only other trigger is an upload arriving, and boot is the moment a
    long-idle instance gets its one chance.
    """
    monkeypatch.setattr(client_errors_router, "get_settings", lambda: _retention(30))
    db_session.add(
        ClientError(
            platform="android",
            message="ancient",
            created_at=datetime.now(UTC) - timedelta(days=31),
        )
    )
    db_session.commit()

    assert client_errors_router.purge_expired_on_startup() == 1


# --- Reading is gated; reporting is not (#354) -----------------------------
#
# `GET /client-errors` was open from #136 until #354, and the live deployment
# answered in full to anyone who asked for it. That was survivable while the
# table held crashes from one tester. It stopped being survivable the moment
# #322 made it hold a daily log from every install.


def test_reading_needs_a_key(client: TestClient):
    assert client.get("/client-errors").status_code == 403


def test_reading_is_closed_when_no_keys_exist_at_all(client: TestClient):
    """Unlike the import gate, this one is **not dormant**.

    `require_unlock_key` is a no-op until the first key exists, which is right
    for a feature that should work on a fresh install. Here "nobody has set up a
    key yet" must mean *closed* — the alternative is that a new deployment
    serves everyone's crash reports to the public until someone remembers.
    """
    assert client.get("/client-errors").status_code == 403


def test_an_ordinary_tester_key_does_not_open_it(client: TestClient, db_session):
    """The whole point of #354's second round, and the bug I caught.

    The first fix gated this on `require_unlock_key`, which is barely a fix:
    every invited tester holds one of these, so it would have let any of them
    read all the others' reports. His words: *"unlock key wont protect it, any
    user with it can still access it, not only me have it."*
    """
    _, tester_token = create_access_key(db_session, "a tester's phone")

    response = client.get("/client-errors", headers={"X-Unlock-Key": tester_token})

    assert response.status_code == 403


def test_an_admin_key_opens_it(client: TestClient, db_session):
    _, token = create_access_key(db_session, "a laptop", is_admin=True)
    client.post("/client-errors", json={"platform": "web", "message": "boom"})

    response = client.get("/client-errors", headers={"X-Unlock-Key": token})

    assert response.status_code == 200
    assert response.json()["total"] == 1


def test_a_revoked_admin_key_stops_working(client: TestClient, db_session):
    row, token = create_access_key(db_session, "an old laptop", is_admin=True)
    row.revoked_at = datetime.now(UTC)
    db_session.commit()

    assert client.get("/client-errors", headers={"X-Unlock-Key": token}).status_code == 403


def test_the_read_can_be_narrowed_to_one_install(client: TestClient, db_session, admin):
    """ "Show me only this tester" — the question asked right after "what broke"."""
    client.post("/client-errors", json={"platform": "android", "message": "mine"})
    other = Install(token_hash=hash_token("someone-elses-install"))
    db_session.add(other)
    db_session.commit()
    db_session.refresh(other)
    client.post(
        "/client-errors",
        json={"platform": "android", "message": "theirs"},
        headers={"X-Install-Id": "someone-elses-install"},
    )

    body = client.get("/client-errors", headers=admin, params={"install": other.id}).json()

    assert [item["message"] for item in body["items"]] == ["theirs"]
    assert body["total"] == 1


def test_reporting_stays_open_even_behind_the_gate(client: TestClient, db_session):
    """The write must never be gated, and this is the test that says why.

    A client crashing during setup has no key — that is precisely the report
    most worth having, and a gate would drop it silently.
    """
    create_access_key(db_session, "a laptop")

    assert (
        client.post("/client-errors", json={"platform": "web", "message": "boom"}).status_code
        == 201
    )
    assert client.post("/client-errors/batch", json={"items": [_entry("a")]}).status_code == 200


def test_the_read_says_which_install_sent_each_report(client: TestClient, install_id: int, admin):
    """`device` cannot tell two testers on the same phone model apart."""
    client.post("/client-errors", json={"platform": "android", "message": "boom"})

    body = client.get("/client-errors", headers=admin).json()

    assert body["items"][0]["owner_install_id"] == install_id
