from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.routers.playlist_imports as imports_router
import app.routers.spotify as spotify_router
from app.config import Settings
from app.installs import resolve_install_id
from app.models import (
    Playlist,
    PlaylistImport,
    PlaylistImportStatus,
    Song,
    SpotifyAccount,
    TrackMatch,
    TrackMatchStatus,
)
from tests.conftest import TEST_INSTALL_TOKEN

# What the retry endpoints handed to the queue, so the tests can check which
# rows were selected without running a real download.
enqueued_retries: list[tuple[int, list[int]]] = []


@pytest.fixture(autouse=True)
def _stub_enqueue(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests on the request/DB contract: record that the task was
    enqueued instead of running the real pipeline."""
    monkeypatch.setattr(imports_router.playlist_import_task, "delay", lambda import_id: None)
    monkeypatch.setattr(imports_router.confirmed_import_task, "delay", lambda import_id: None)
    enqueued_retries.clear()
    monkeypatch.setattr(
        imports_router.retry_failed_matches_task,
        "delay",
        lambda import_id, match_ids: enqueued_retries.append((import_id, match_ids)),
    )


def _settings(client_id: str | None) -> Settings:
    return Settings(
        spotify_client_id=client_id,
        spotify_redirect_uri="http://127.0.0.1:8000/spotify/callback",
        frontend_base_url="http://localhost:5173",
    )


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spotify_router, "get_settings", lambda: _settings("test-client-id"))


@pytest.fixture
def unconfigured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spotify_router, "get_settings", lambda: _settings(None))


@pytest.fixture
def account(db_session: Session) -> SpotifyAccount:
    row = SpotifyAccount(
        spotify_user_id="user-1",
        display_name="Alex",
        access_token="acc-1",
        refresh_token="ref-1",
        token_expires_at=datetime.now(UTC) + timedelta(hours=1),
        scopes="playlist-read-private",
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def seed_import(
    db_session: Session,
    account: SpotifyAccount | None = None,
    status: PlaylistImportStatus = PlaylistImportStatus.QUEUED,
    owner_install_id: int | None = None,
) -> PlaylistImport:
    # Owned by the suite's default install (#170), because that is who the
    # `client` fixture identifies as. Left unowned the row is invisible to every
    # request, and all 24 tests in this file 404. Resolved here rather than
    # threaded through every call site, since they all already pass `db_session`.
    if owner_install_id is None:
        owner_install_id = resolve_install_id(db_session, TEST_INSTALL_TOKEN, create=True)
    row = PlaylistImport(
        service="spotify",
        account_id=account.id if account else None,
        external_playlist_id="pl-1",
        name="Road Trip",
        status=status,
        owner_install_id=owner_install_id,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def seed_match(
    db_session: Session,
    playlist_import: PlaylistImport,
    position: int,
    status: TrackMatchStatus,
    with_url: bool = True,
) -> TrackMatch:
    row = TrackMatch(
        playlist_import_id=playlist_import.id,
        position=position,
        title=f"Song {position}",
        artist="Artist",
        duration_s=200.0,
        candidates=[
            {
                "url": f"https://www.youtube.com/watch?v={position}",
                "title": f"Song {position}",
                "uploader": "Artist",
                "duration": 200.0,
                "score": 0.9,
            }
        ],
        chosen_url=f"https://www.youtube.com/watch?v={position}" if with_url else None,
        confidence=0.9 if with_url else None,
        status=status,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def test_create_returns_queued_import(
    client: TestClient, configured: None, account: SpotifyAccount
) -> None:
    response = client.post(
        "/playlist-imports",
        json={"account_id": account.id, "playlist_id": "pl-1", "name": "Road Trip"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "queued"
    assert body["external_playlist_id"] == "pl-1"
    assert body["name"] == "Road Trip"
    assert body["account_id"] == account.id
    assert body["matched_count"] == 0


def test_create_unknown_account_is_404(client: TestClient, configured: None) -> None:
    response = client.post(
        "/playlist-imports",
        json={"account_id": 999, "playlist_id": "pl-1", "name": "Road Trip"},
    )

    assert response.status_code == 404


def test_create_requires_spotify_configuration(
    client: TestClient, unconfigured: None, account: SpotifyAccount
) -> None:
    response = client.post(
        "/playlist-imports",
        json={"account_id": account.id, "playlist_id": "pl-1", "name": "Road Trip"},
    )

    assert response.status_code == 503


def test_create_youtube_import_needs_no_spotify(client: TestClient, unconfigured: None) -> None:
    response = client.post(
        "/playlist-imports/youtube",
        json={"url": "https://www.youtube.com/playlist?list=PL123"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["service"] == "youtube"
    assert body["account_id"] is None
    assert body["status"] == "queued"
    assert body["external_playlist_id"] == "https://www.youtube.com/playlist?list=PL123"


def test_create_youtube_import_requires_a_url(client: TestClient) -> None:
    assert client.post("/playlist-imports/youtube", json={"url": ""}).status_code == 422
    assert client.post("/playlist-imports/youtube", json={}).status_code == 422


def _external_body(**overrides: object) -> dict:
    body: dict = {
        "service": "netease",
        "source_url": "https://music.163.com/#/playlist?id=79177352",
        "name": "Billboard 2007 Top 100",
        "tracks": [
            {"external_id": "21534415", "title": "Same Girl", "artist": "R. Kelly, Usher"},
            {
                "external_id": "22227939",
                "title": "Paralyzer",
                "artist": "Finger Eleven",
                "album": "Them vs. You vs. Me",
                "duration_s": 208.1,
            },
        ],
    }
    body.update(overrides)
    return body


def test_external_import_starts_ready_for_client_candidates(
    client: TestClient, unconfigured: None, db_session: Session
) -> None:
    """ADR-013: the device already fetched the list, so there is no fetch phase
    and the run lands exactly where a `client_matches` Spotify run stops."""
    response = client.post("/playlist-imports/external", json=_external_body())

    assert response.status_code == 201
    body = response.json()
    assert body["service"] == "netease"
    assert body["account_id"] is None
    # Not "queued": nothing on the server has work to do until candidates arrive.
    assert body["status"] == "matching"
    assert body["client_matches"] is True
    assert body["track_count"] == 2
    assert body["matched_count"] == 0
    assert body["external_playlist_id"] == "https://music.163.com/#/playlist?id=79177352"


def test_external_import_writes_the_tracks_in_order(
    client: TestClient, db_session: Session
) -> None:
    import_id = client.post("/playlist-imports/external", json=_external_body()).json()["id"]

    matches = db_session.scalars(
        select(TrackMatch)
        .where(TrackMatch.playlist_import_id == import_id)
        .order_by(TrackMatch.position)
    ).all()

    assert [(m.position, m.title) for m in matches] == [(0, "Same Girl"), (1, "Paralyzer")]
    assert [m.external_id for m in matches] == ["21534415", "22227939"]
    assert [m.artist for m in matches] == ["R. Kelly, Usher", "Finger Eleven"]
    assert [m.album for m in matches] == [None, "Them vs. You vs. Me"]
    assert [m.duration_s for m in matches] == [None, 208.1]
    # Pending is what `POST /{id}/candidates` requires to do anything at all.
    assert {m.status for m in matches} == {TrackMatchStatus.PENDING}


def test_external_import_enqueues_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fetch already happened on the device. Enqueuing the pipeline would
    run `run_playlist_import` against an import with no Spotify account."""
    enqueued: list[int] = []
    monkeypatch.setattr(imports_router.playlist_import_task, "delay", enqueued.append)

    assert client.post("/playlist-imports/external", json=_external_body()).status_code == 201

    assert enqueued == []


def test_external_import_accepts_a_track_with_no_artist(client: TestClient) -> None:
    """Kugou glues artist and title into one `filename`, and the split can fail.
    An empty artist is a real answer — it costs the track auto-matching, which
    is the point, but it must not cost the import."""
    body = _external_body(
        service="kugou",
        tracks=[{"title": "成都 - 现场版", "duration_s": 328}],
    )

    response = client.post("/playlist-imports/external", json=body)

    assert response.status_code == 201
    assert response.json()["track_count"] == 1


def test_external_import_takes_candidates_and_reaches_review(client: TestClient) -> None:
    """The whole reason this starts at `matching`: every later endpoint has to
    work unchanged. Asserted end to end rather than by reading the status."""
    created = client.post("/playlist-imports/external", json=_external_body()).json()
    matches = client.get(f"/playlist-imports/{created['id']}/matches").json()["items"]

    response = client.post(
        f"/playlist-imports/{created['id']}/candidates",
        json={
            "tracks": [
                {
                    "match_id": match["id"],
                    "results": [
                        {
                            "url": f"https://www.youtube.com/watch?v={match['position']}",
                            "title": match["title"],
                            "uploader": match["artist"],
                            "duration": match["duration_s"],
                        }
                    ],
                }
                for match in matches
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "review"
    assert response.json()["matched_count"] == 2


def test_candidates_carry_their_source_through_to_the_stored_row(
    client: TestClient, db_session: Session
) -> None:
    """#551: the review screen has to be able to say where a match came from,
    and `_is_topic_channel` has to be able to refuse the bonus to a non-YouTube
    uploader. Both need the source to survive the wire, not just the scorer."""
    created = client.post("/playlist-imports/external", json=_external_body()).json()
    matches = client.get(f"/playlist-imports/{created['id']}/matches").json()["items"]

    client.post(
        f"/playlist-imports/{created['id']}/candidates",
        json={
            "tracks": [
                {
                    "match_id": matches[0]["id"],
                    "results": [
                        {
                            "url": "https://www.bilibili.com/video/BV1xx411c7mD",
                            "title": matches[0]["title"],
                            "uploader": "somebody - Topic",
                            "source": "bilibili",
                        }
                    ],
                }
            ]
        },
    )

    row = db_session.scalar(select(TrackMatch).where(TrackMatch.id == matches[0]["id"]))
    db_session.refresh(row)
    assert row.candidates[0]["source"] == "bilibili"
    # The " - Topic" name must not have earned anything off YouTube.
    assert row.candidates[0]["score"] < 1.0


def test_candidates_default_to_youtube_when_no_source_is_sent(
    client: TestClient, db_session: Session
) -> None:
    """The web client searches YouTube only and does not send the field. It must
    keep behaving exactly as it did — including still earning the Topic bonus."""
    created = client.post("/playlist-imports/external", json=_external_body()).json()
    matches = client.get(f"/playlist-imports/{created['id']}/matches").json()["items"]

    client.post(
        f"/playlist-imports/{created['id']}/candidates",
        json={
            "tracks": [
                {
                    "match_id": matches[0]["id"],
                    "results": [
                        {"url": "https://y.t/1", "title": matches[0]["title"], "uploader": "x"}
                    ],
                }
            ]
        },
    )

    row = db_session.scalar(select(TrackMatch).where(TrackMatch.id == matches[0]["id"]))
    db_session.refresh(row)
    assert row.candidates[0]["source"] == "youtube"


def test_candidates_reject_an_unknown_source(client: TestClient) -> None:
    """A closed set, unlike the import's `service` slug: this field *changes
    scoring*, so an unrecognised value must be refused rather than quietly
    treated as neither YouTube nor Bilibili."""
    created = client.post("/playlist-imports/external", json=_external_body()).json()
    matches = client.get(f"/playlist-imports/{created['id']}/matches").json()["items"]

    response = client.post(
        f"/playlist-imports/{created['id']}/candidates",
        json={
            "tracks": [
                {
                    "match_id": matches[0]["id"],
                    "results": [{"url": "https://x/1", "title": "t", "source": "soundcloud"}],
                }
            ]
        },
    )

    assert response.status_code == 422


def test_external_import_rejects_a_bad_body(client: TestClient) -> None:
    assert client.post(
        "/playlist-imports/external", json=_external_body(tracks=[])
    ).status_code == (422)
    # A service slug is a label, but it is stored and displayed, so it is bounded.
    assert (
        client.post(
            "/playlist-imports/external", json=_external_body(service="NetEase!")
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/playlist-imports/external", json=_external_body(tracks=[{"title": ""}])
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/playlist-imports/external", json=_external_body(tracks=[{"artist": "nobody"}])
        ).status_code
        == 422
    )


def test_external_import_needs_an_install(client: TestClient) -> None:
    """A row owned by nobody would be invisible to everybody (#170)."""
    client.headers.pop("X-Install-Id", None)

    assert client.post("/playlist-imports/external", json=_external_body()).status_code == 400


def test_list_orders_newest_first(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    first = seed_import(db_session, account)
    second = seed_import(db_session, account)

    body = client.get("/playlist-imports").json()

    assert [item["id"] for item in body["items"]] == [second.id, first.id]
    assert body["total"] == 2
    assert body["limit"] == 50


def test_history_stays_readable_without_configuration(
    client: TestClient, unconfigured: None, db_session: Session
) -> None:
    playlist_import = seed_import(db_session)

    response = client.get(f"/playlist-imports/{playlist_import.id}")

    assert response.status_code == 200
    assert response.json()["account_id"] is None


def test_detail_unknown_import_is_404(client: TestClient) -> None:
    assert client.get("/playlist-imports/999999").status_code == 404


def test_matches_are_paginated_in_playlist_order(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account)
    seed_match(db_session, playlist_import, 1, TrackMatchStatus.NEEDS_REVIEW)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)
    seed_match(db_session, playlist_import, 2, TrackMatchStatus.NO_MATCH)

    body = client.get(f"/playlist-imports/{playlist_import.id}/matches").json()

    assert [item["position"] for item in body["items"]] == [0, 1, 2]
    assert body["total"] == 3
    assert body["items"][0]["candidates"][0]["score"] == 0.9


def test_matches_endpoint_serializes_a_scoreless_candidate(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    # A YouTube-playlist entry is its own candidate and has no machine score;
    # the read schema must allow score=None (else the matches list 500s).
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    db_session.add(
        TrackMatch(
            playlist_import_id=playlist_import.id,
            position=0,
            title="One",
            artist="A",
            duration_s=None,
            candidates=[
                {
                    "url": "https://y/1",
                    "title": "One",
                    "uploader": "A",
                    "duration": None,
                    "score": None,
                }
            ],
            chosen_url="https://y/1",
            confidence=None,
            status=TrackMatchStatus.AUTO_MATCHED,
        )
    )
    db_session.commit()

    response = client.get(f"/playlist-imports/{playlist_import.id}/matches")

    assert response.status_code == 200
    assert response.json()["items"][0]["candidates"][0]["score"] is None


def test_matches_filter_by_status(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)
    seed_match(db_session, playlist_import, 1, TrackMatchStatus.NEEDS_REVIEW)

    body = client.get(f"/playlist-imports/{playlist_import.id}/matches?status=needs_review").json()

    assert body["total"] == 1
    assert body["items"][0]["status"] == "needs_review"


def test_matches_unknown_import_is_404(client: TestClient) -> None:
    assert client.get("/playlist-imports/999999/matches").status_code == 404


def test_patch_accepts_a_reviewable_match(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.NEEDS_REVIEW)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches/{match.id}",
        json={"status": "accepted"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "accepted"


def test_patch_accept_without_a_chosen_url_is_400(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.NO_MATCH, with_url=False)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches/{match.id}",
        json={"status": "accepted"},
    )

    assert response.status_code == 400


def test_patch_rejects_a_match(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches/{match.id}",
        json={"status": "rejected"},
    )

    assert response.json()["status"] == "rejected"


def test_patch_chosen_url_tracks_candidate_confidence(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.NEEDS_REVIEW)
    url = f"/playlist-imports/{playlist_import.id}/matches/{match.id}"

    # A hand-pasted URL has no machine confidence...
    custom = client.patch(url, json={"chosen_url": "https://example.com/custom"}).json()
    assert custom["chosen_url"] == "https://example.com/custom"
    assert custom["confidence"] is None

    # ...while picking a stored candidate restores its score.
    candidate = client.patch(url, json={"chosen_url": "https://www.youtube.com/watch?v=0"}).json()
    assert candidate["confidence"] == 0.9


def test_patch_is_blocked_outside_review(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account)  # still queued
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches/{match.id}",
        json={"status": "rejected"},
    )

    assert response.status_code == 409


def test_patch_can_repoint_after_the_run_has_finished(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    """#399's affordance, which this endpoint used to refuse with a 409.

    Changing the source of a track the device could not fetch is only useful
    *after* the run — during review the track has not been attempted yet. I
    hit the refusal on 2026-08-09 with two tracks that had 403'd, which is
    exactly the case the feature was built for.
    """
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.DONE)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches/{match.id}",
        json={"chosen_url": "https://www.youtube.com/watch?v=elsewhere", "status": "accepted"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["chosen_url"] == "https://www.youtube.com/watch?v=elsewhere"
    # A hand-pasted URL has no machine confidence, whatever the run recorded.
    assert body["confidence"] is None


def test_patch_is_blocked_while_the_import_is_running(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    """The one status repointing must not reach.

    The download loop is walking these rows; changing a URL under it would mean
    a track fetched from one source and recorded as another.
    """
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.IMPORTING)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches/{match.id}",
        json={"chosen_url": "https://www.youtube.com/watch?v=elsewhere"},
    )

    assert response.status_code == 409


def test_bulk_patch_stays_review_only_after_the_run(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    """Repointing one track opened up; bulk accept/reject did not.

    Bulk is a *review* action. Applying it to a finished import would flip rows
    the run has already acted on, with nothing to reconcile them against.
    """
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.DONE)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches",
        json={"match_ids": [match.id], "status": "rejected"},
    )

    assert response.status_code == 409


def test_patch_unknown_or_mismatched_match_is_404(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    first = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    second = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    foreign = seed_match(db_session, second, 0, TrackMatchStatus.AUTO_MATCHED)

    assert (
        client.patch(
            f"/playlist-imports/{first.id}/matches/999999", json={"status": "rejected"}
        ).status_code
        == 404
    )
    assert (
        client.patch(
            f"/playlist-imports/{first.id}/matches/{foreign.id}", json={"status": "rejected"}
        ).status_code
        == 404
    )


def test_bulk_patch_accepts_and_rejects_many_matches(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    a = seed_match(db_session, playlist_import, 0, TrackMatchStatus.NEEDS_REVIEW)
    b = seed_match(db_session, playlist_import, 1, TrackMatchStatus.NEEDS_REVIEW)
    untouched = seed_match(db_session, playlist_import, 2, TrackMatchStatus.AUTO_MATCHED)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches",
        json={"match_ids": [a.id, b.id], "status": "accepted"},
    )

    assert response.status_code == 200
    assert {row["id"]: row["status"] for row in response.json()} == {
        a.id: "accepted",
        b.id: "accepted",
    }
    # A match outside the selection is left alone.
    db_session.refresh(untouched)
    assert untouched.status == TrackMatchStatus.AUTO_MATCHED


def test_bulk_patch_skips_matches_without_a_chosen_url(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    with_url = seed_match(db_session, playlist_import, 0, TrackMatchStatus.NEEDS_REVIEW)
    no_url = seed_match(db_session, playlist_import, 1, TrackMatchStatus.NO_MATCH, with_url=False)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches",
        json={"match_ids": [with_url.id, no_url.id], "status": "accepted"},
    )

    # The URL-less one is skipped, not an error; the batch still succeeds.
    assert response.status_code == 200
    assert [row["id"] for row in response.json()] == [with_url.id]
    db_session.refresh(no_url)
    assert no_url.status == TrackMatchStatus.NO_MATCH


def test_bulk_patch_is_blocked_outside_review(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account)  # still queued
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches",
        json={"match_ids": [match.id], "status": "rejected"},
    )

    assert response.status_code == 409


def test_bulk_patch_requires_at_least_one_id(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)

    response = client.patch(
        f"/playlist-imports/{playlist_import.id}/matches",
        json={"match_ids": [], "status": "rejected"},
    )

    assert response.status_code == 422


def test_confirm_starts_the_download_phase(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)
    seed_match(db_session, playlist_import, 1, TrackMatchStatus.ACCEPTED)
    seed_match(db_session, playlist_import, 2, TrackMatchStatus.REJECTED)

    response = client.post(f"/playlist-imports/{playlist_import.id}/confirm")

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "importing"
    assert body["import_total"] == 2


def test_confirm_without_download_enqueues_nothing(
    client: TestClient, db_session: Session, account: SpotifyAccount, monkeypatch
) -> None:
    """The mobile client fetches on the device (#268).

    Confirming used to mean two things at once — *the user accepted these* and
    *server, go and fetch them*. YouTube refuses the second from a datacenter
    address (1 in 14, #177), so the phone does it instead. The acceptance still
    has to be recorded, or the import sits at `review` forever.
    """
    enqueued: list[int] = []
    monkeypatch.setattr(
        imports_router.confirmed_import_task, "delay", lambda import_id: enqueued.append(import_id)
    )
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.ACCEPTED)
    seed_match(db_session, playlist_import, 1, TrackMatchStatus.ACCEPTED)

    response = client.post(
        f"/playlist-imports/{playlist_import.id}/confirm", json={"download": False}
    )

    assert response.status_code == 202
    body = response.json()
    # The server's part is finished the moment it says so — there is nothing
    # left for it to do, so `importing` would be a lie.
    assert body["status"] == "done"
    assert body["import_total"] == 2
    # `this server` imported nothing; the count that matters lives on the device.
    assert body["imported_count"] == 0
    assert enqueued == []


def test_confirm_still_downloads_by_default(
    client: TestClient, db_session: Session, account: SpotifyAccount, monkeypatch
) -> None:
    """Every existing caller is unchanged, the web client included — which is
    the whole reason the flag exists rather than confirm simply stopping."""
    enqueued: list[int] = []
    monkeypatch.setattr(
        imports_router.confirmed_import_task, "delay", lambda import_id: enqueued.append(import_id)
    )
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.ACCEPTED)

    # No body at all, as the web client sends.
    response = client.post(f"/playlist-imports/{playlist_import.id}/confirm")

    assert response.status_code == 202
    assert response.json()["status"] == "importing"
    assert enqueued == [playlist_import.id]


def test_confirm_without_download_still_needs_something_accepted(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    # The guard is about the import, not about who downloads.
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.REJECTED)

    response = client.post(
        f"/playlist-imports/{playlist_import.id}/confirm", json={"download": False}
    )

    assert response.status_code == 409


def test_confirm_double_click_hits_the_guard(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.AUTO_MATCHED)

    assert client.post(f"/playlist-imports/{playlist_import.id}/confirm").status_code == 202
    assert client.post(f"/playlist-imports/{playlist_import.id}/confirm").status_code == 409


def test_confirm_with_nothing_importable_is_409(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.REVIEW)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.REJECTED)
    seed_match(db_session, playlist_import, 1, TrackMatchStatus.NO_MATCH, with_url=False)

    assert client.post(f"/playlist-imports/{playlist_import.id}/confirm").status_code == 409


def test_confirm_outside_review_is_409(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account)  # still queued

    assert client.post(f"/playlist-imports/{playlist_import.id}/confirm").status_code == 409


def test_delete_removes_the_import_and_its_matches(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.DONE)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.IMPORTED)

    response = client.delete(f"/playlist-imports/{playlist_import.id}")

    assert response.status_code == 204
    # Drop the deleted instance from this session's identity map so the reads
    # below actually hit the database.
    db_session.expunge_all()
    assert db_session.get(PlaylistImport, playlist_import.id) is None
    assert db_session.scalars(select(TrackMatch)).all() == []


def test_delete_leaves_the_songs_alone(
    client: TestClient, db_session: Session, account: SpotifyAccount, make_song
) -> None:
    """Deleting the record of an import must never delete your music."""
    song = make_song(title="Imported Song")
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.DONE)
    match = seed_match(db_session, playlist_import, 0, TrackMatchStatus.IMPORTED)
    match.song_id = song.id
    db_session.commit()

    client.delete(f"/playlist-imports/{playlist_import.id}")

    db_session.expire_all()
    assert db_session.get(Song, song.id) is not None


def test_delete_is_blocked_while_running(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.MATCHING)

    assert client.delete(f"/playlist-imports/{playlist_import.id}").status_code == 409


def test_delete_unknown_import_is_404(client: TestClient) -> None:
    assert client.delete("/playlist-imports/999999").status_code == 404


def _finished_import(db_session: Session, account: SpotifyAccount) -> PlaylistImport:
    playlist = Playlist(name="Road Trip")
    db_session.add(playlist)
    db_session.flush()
    playlist_import = seed_import(db_session, account, status=PlaylistImportStatus.DONE)
    playlist_import.playlist_id = playlist.id
    playlist_import.import_total = 2
    db_session.commit()
    return playlist_import


def test_retry_failed_starts_a_run_for_the_failed_rows(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = _finished_import(db_session, account)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.IMPORTED)
    first = seed_match(db_session, playlist_import, 1, TrackMatchStatus.FAILED)
    second = seed_match(db_session, playlist_import, 2, TrackMatchStatus.FAILED)

    response = client.post(f"/playlist-imports/{playlist_import.id}/retry-failed")

    assert response.status_code == 202
    assert response.json()["status"] == "importing"
    assert enqueued_retries == [(playlist_import.id, [first.id, second.id])]


def test_retry_failed_with_nothing_to_do_is_409(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = _finished_import(db_session, account)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.IMPORTED)

    assert client.post(f"/playlist-imports/{playlist_import.id}/retry-failed").status_code == 409


def test_retry_failed_is_blocked_while_running(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = _finished_import(db_session, account)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.FAILED)
    playlist_import.status = PlaylistImportStatus.IMPORTING
    db_session.commit()

    assert client.post(f"/playlist-imports/{playlist_import.id}/retry-failed").status_code == 409


def test_retry_one_match(client: TestClient, db_session: Session, account: SpotifyAccount) -> None:
    playlist_import = _finished_import(db_session, account)
    seed_match(db_session, playlist_import, 0, TrackMatchStatus.FAILED)
    target = seed_match(db_session, playlist_import, 1, TrackMatchStatus.FAILED)

    response = client.post(f"/playlist-imports/{playlist_import.id}/matches/{target.id}/retry")

    assert response.status_code == 202
    assert enqueued_retries == [(playlist_import.id, [target.id])]  # only that one


def test_retry_a_match_that_did_not_fail_is_409(
    client: TestClient, db_session: Session, account: SpotifyAccount
) -> None:
    playlist_import = _finished_import(db_session, account)
    imported = seed_match(db_session, playlist_import, 0, TrackMatchStatus.IMPORTED)

    response = client.post(f"/playlist-imports/{playlist_import.id}/matches/{imported.id}/retry")

    assert response.status_code == 409


# ---------------------------------------------------------------------------
# Client-supplied candidates (#353)
# ---------------------------------------------------------------------------
#
# The search moved to the device because YouTube refuses the droplet's address
# on every client (#177). The *scorer* deliberately did not move, so these tests
# are about the seam: what the phone is allowed to post, what the server does
# with it, and what it refuses.


def _candidate(url: str, title: str, duration: float | None = 200.0) -> dict:
    return {"url": url, "title": title, "uploader": "Artist", "duration": duration}


def test_create_records_that_the_client_will_match(
    client: TestClient, configured: None, account: SpotifyAccount, db_session: Session
) -> None:
    response = client.post(
        "/playlist-imports",
        json={
            "account_id": account.id,
            "playlist_id": "pl-1",
            "name": "Road Trip",
            "client_matches": True,
        },
    )

    assert response.status_code == 201
    row = db_session.get(PlaylistImport, response.json()["id"])
    assert row is not None and row.client_matches is True


def test_create_defaults_to_server_side_matching(
    client: TestClient, configured: None, account: SpotifyAccount, db_session: Session
) -> None:
    # The web client sends no such field and must keep the old behaviour — the
    # whole reason this is a flag rather than a change of pipeline.
    response = client.post(
        "/playlist-imports",
        json={"account_id": account.id, "playlist_id": "pl-1", "name": "Road Trip"},
    )

    row = db_session.get(PlaylistImport, response.json()["id"])
    assert row is not None and row.client_matches is False


def test_candidates_are_scored_and_the_best_one_chosen(
    client: TestClient, db_session: Session
) -> None:
    imp = seed_import(db_session, status=PlaylistImportStatus.MATCHING)
    match = seed_match(db_session, imp, 0, TrackMatchStatus.PENDING, with_url=False)
    match.title = "Ceremony"
    match.artist = "New Order"
    match.duration_s = 264.0
    db_session.commit()

    response = client.post(
        f"/playlist-imports/{imp.id}/candidates",
        json={
            "tracks": [
                {
                    "match_id": match.id,
                    "results": [
                        _candidate("https://youtu.be/wrong", "Something Else Entirely", 12.0),
                        _candidate("https://youtu.be/right", "New Order - Ceremony", 264.0),
                    ],
                }
            ]
        },
    )

    assert response.status_code == 200
    db_session.refresh(match)
    # The server ranked them: the phone posted the wrong one first.
    assert match.chosen_url == "https://youtu.be/right"
    assert match.confidence is not None and match.confidence > 0.8
    assert match.status == TrackMatchStatus.AUTO_MATCHED
    assert [candidate["url"] for candidate in match.candidates] == [
        "https://youtu.be/right",
        "https://youtu.be/wrong",
    ]


def test_a_track_the_client_found_nothing_for_is_no_match(
    client: TestClient, db_session: Session
) -> None:
    # An empty list is meaningful: it says "I searched and found nothing",
    # which has to end the row rather than leave it pending forever.
    imp = seed_import(db_session, status=PlaylistImportStatus.MATCHING)
    match = seed_match(db_session, imp, 0, TrackMatchStatus.PENDING, with_url=False)

    client.post(
        f"/playlist-imports/{imp.id}/candidates",
        json={"tracks": [{"match_id": match.id, "results": []}]},
    )

    db_session.refresh(match)
    assert match.status == TrackMatchStatus.NO_MATCH


def test_the_import_reaches_review_once_every_track_is_matched(
    client: TestClient, db_session: Session
) -> None:
    imp = seed_import(db_session, status=PlaylistImportStatus.MATCHING)
    first = seed_match(db_session, imp, 0, TrackMatchStatus.PENDING, with_url=False)
    second = seed_match(db_session, imp, 1, TrackMatchStatus.PENDING, with_url=False)

    partial = client.post(
        f"/playlist-imports/{imp.id}/candidates",
        json={"tracks": [{"match_id": first.id, "results": [_candidate("https://a", "Song 0")]}]},
    )
    assert partial.json()["status"] == "matching"
    assert partial.json()["matched_count"] == 1

    done = client.post(
        f"/playlist-imports/{imp.id}/candidates",
        json={"tracks": [{"match_id": second.id, "results": [_candidate("https://b", "Song 1")]}]},
    )
    assert done.json()["status"] == "review"
    assert done.json()["matched_count"] == 2


def test_resending_a_track_does_not_double_count_it(
    client: TestClient, db_session: Session
) -> None:
    """A phone that lost its connection half way through resends the batch.

    `matched_count` is recomputed from the rows rather than incremented, which
    is what makes that safe. Incrementing would count the resent track twice —
    and with two tracks that reaches the total, so the run would flip to
    `review` with a track still unmatched.
    """
    imp = seed_import(db_session, status=PlaylistImportStatus.MATCHING)
    first = seed_match(db_session, imp, 0, TrackMatchStatus.PENDING, with_url=False)
    seed_match(db_session, imp, 1, TrackMatchStatus.PENDING, with_url=False)

    body = {"tracks": [{"match_id": first.id, "results": [_candidate("https://a", "Song 0")]}]}
    client.post(f"/playlist-imports/{imp.id}/candidates", json=body)
    again = client.post(f"/playlist-imports/{imp.id}/candidates", json=body)

    assert again.json()["matched_count"] == 1
    assert again.json()["status"] == "matching"


def test_candidates_are_refused_outside_the_matching_phase(
    client: TestClient, db_session: Session
) -> None:
    # Accepting these during review would rewrite a choice the user had already
    # made, from a request they did not send.
    imp = seed_import(db_session, status=PlaylistImportStatus.REVIEW)
    match = seed_match(db_session, imp, 0, TrackMatchStatus.AUTO_MATCHED)

    response = client.post(
        f"/playlist-imports/{imp.id}/candidates",
        json={"tracks": [{"match_id": match.id, "results": [_candidate("https://a", "x")]}]},
    )

    assert response.status_code == 409


def test_candidates_for_another_imports_track_are_refused(
    client: TestClient, db_session: Session
) -> None:
    # All or nothing on identity: silently skipping a foreign match id would
    # make a bug look like a success.
    mine = seed_import(db_session, status=PlaylistImportStatus.MATCHING)
    seed_match(db_session, mine, 0, TrackMatchStatus.PENDING, with_url=False)
    theirs = seed_import(db_session, status=PlaylistImportStatus.MATCHING)
    foreign = seed_match(db_session, theirs, 0, TrackMatchStatus.PENDING, with_url=False)

    response = client.post(
        f"/playlist-imports/{mine.id}/candidates",
        json={"tracks": [{"match_id": foreign.id, "results": [_candidate("https://a", "x")]}]},
    )

    assert response.status_code == 404
    db_session.refresh(foreign)
    assert foreign.status == TrackMatchStatus.PENDING


def test_rematching_clears_a_previous_error(client: TestClient, db_session: Session) -> None:
    # A row that failed on the first attempt kept its message, so a track that
    # succeeded on retry still showed the reason it had failed.
    imp = seed_import(db_session, status=PlaylistImportStatus.MATCHING)
    match = seed_match(db_session, imp, 0, TrackMatchStatus.NO_MATCH, with_url=False)
    match.error = "Sign in to confirm you're not a bot"
    db_session.commit()

    client.post(
        f"/playlist-imports/{imp.id}/candidates",
        json={"tracks": [{"match_id": match.id, "results": [_candidate("https://a", "Song 0")]}]},
    )

    db_session.refresh(match)
    assert match.error is None
