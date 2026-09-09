from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.playlist_imports as pipeline
from app.config import get_settings
from app.db import SessionLocal
from app.matching import ScoredCandidate
from app.models import (
    ImportJob,
    ImportStatus,
    Playlist,
    PlaylistImport,
    PlaylistImportStatus,
    PlaylistItem,
    Song,
    SpotifyAccount,
    TrackMatch,
    TrackMatchStatus,
)
from app.playlist_imports import (
    fail_interrupted_imports,
    run_confirmed_import,
    run_playlist_import,
    run_retry_failed_matches,
)
from app.spotify import SpotifyAuthError, SpotifyTrack
from app.ytdlp import (
    ExtractionError,
    PlaylistEntry,
    PlaylistListing,
    SearchResult,
    TransientExtractionError,
)


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


@pytest.fixture
def make_import(db_session: Session, account: SpotifyAccount, install_id: int):
    def _make(
        external_playlist_id: str = "pl-1",
        account_id: int | None = None,
        client_matches: bool = False,
    ) -> PlaylistImport:
        row = PlaylistImport(
            service="spotify",
            account_id=account.id if account_id is None else account_id,
            external_playlist_id=external_playlist_id,
            name="Road Trip",
            client_matches=client_matches,
            # Owned, because the confirm phase only reuses songs the *same* owner
            # already has (#170). Left unowned, the reuse lookup finds nothing.
            owner_install_id=install_id,
        )
        db_session.add(row)
        db_session.commit()
        db_session.refresh(row)
        return row

    return _make


@pytest.fixture(autouse=True)
def _fresh_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pipeline, "get_fresh_access_token", lambda db, account, client_id: "token")


@pytest.fixture(autouse=True)
def _no_retry_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """The inline batch retry (B3) backs off with real 20s+ waits; no test wants
    to actually sleep through them."""
    monkeypatch.setattr(pipeline.time, "sleep", lambda _seconds: None)


def make_track(n: int) -> SpotifyTrack:
    return SpotifyTrack(
        external_id=f"t{n}", title=f"Song {n}", artist="Artist", album=None, duration_s=200.0
    )


def make_result(n: int) -> SearchResult:
    return SearchResult(
        url=f"https://www.youtube.com/watch?v={n}",
        title=f"Song {n}",
        uploader="Artist",
        duration=200.0,
    )


def make_scored(n: int, score: float = 0.9) -> ScoredCandidate:
    return ScoredCandidate(
        url=f"https://www.youtube.com/watch?v={n}",
        title=f"Song {n}",
        uploader="Artist",
        duration=200.0,
        score=score,
    )


def reload_import(db_session: Session, import_id: int) -> PlaylistImport:
    db_session.expire_all()
    row = db_session.get(PlaylistImport, import_id)
    assert row is not None
    return row


def test_happy_path_ends_in_review_with_scored_matches(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    monkeypatch.setattr(
        pipeline,
        "fetch_all_playlist_tracks",
        lambda token, playlist_id: [make_track(1), make_track(2), make_track(3)],
    )
    monkeypatch.setattr(pipeline, "search", lambda query, limit: [make_result(1)])
    monkeypatch.setattr(
        pipeline,
        "score_candidates",
        lambda title, artist, duration_s, results: [make_scored(1, 0.9)],
    )

    run_playlist_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.REVIEW
    assert imp.track_count == 3
    assert imp.matched_count == 3
    assert imp.error is None

    matches = db_session.scalars(
        select(TrackMatch)
        .where(TrackMatch.playlist_import_id == imp.id)
        .order_by(TrackMatch.position)
    ).all()
    assert [match.position for match in matches] == [0, 1, 2]
    assert all(match.status == TrackMatchStatus.AUTO_MATCHED for match in matches)
    assert matches[0].chosen_url == "https://www.youtube.com/watch?v=1"
    assert matches[0].confidence == 0.9
    assert matches[0].candidates[0]["score"] == 0.9


def test_liked_sentinel_routes_to_saved_tracks(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import(external_playlist_id="liked")
    saved_calls: list[str] = []

    def fake_saved(token: str) -> list[SpotifyTrack]:
        saved_calls.append(token)
        return [make_track(1)]

    def fail_playlist(token: str, playlist_id: str) -> list[SpotifyTrack]:
        raise AssertionError("liked imports must not hit the playlist endpoint")

    monkeypatch.setattr(pipeline, "fetch_all_saved_tracks", fake_saved)
    monkeypatch.setattr(pipeline, "fetch_all_playlist_tracks", fail_playlist)
    monkeypatch.setattr(pipeline, "search", lambda query, limit: [make_result(1)])
    monkeypatch.setattr(
        pipeline,
        "score_candidates",
        lambda title, artist, duration_s, results: [make_scored(1)],
    )

    run_playlist_import(imp.id)

    assert saved_calls == ["token"]
    assert reload_import(db_session, imp.id).status == PlaylistImportStatus.REVIEW


def test_spotify_failure_during_fetch_fails_the_import(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()

    def fail_fetch(token: str, playlist_id: str) -> list[SpotifyTrack]:
        raise SpotifyAuthError("Spotify rejected the request (403) — Premium may have lapsed")

    monkeypatch.setattr(pipeline, "fetch_all_playlist_tracks", fail_fetch)

    run_playlist_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.FAILED
    assert "Premium" in (imp.error or "")
    assert imp.track_count is None


def test_one_failed_search_degrades_only_that_row(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    monkeypatch.setattr(
        pipeline,
        "fetch_all_playlist_tracks",
        lambda token, playlist_id: [make_track(1), make_track(2)],
    )
    calls = {"count": 0}

    def flaky_search(query: str, limit: int) -> list[SearchResult]:
        calls["count"] += 1
        if calls["count"] == 1:
            raise ExtractionError("search blocked")
        return [make_result(2)]

    monkeypatch.setattr(pipeline, "search", flaky_search)
    monkeypatch.setattr(
        pipeline,
        "score_candidates",
        lambda title, artist, duration_s, results: [make_scored(2)],
    )

    run_playlist_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.REVIEW
    assert imp.matched_count == 2

    matches = db_session.scalars(
        select(TrackMatch)
        .where(TrackMatch.playlist_import_id == imp.id)
        .order_by(TrackMatch.position)
    ).all()
    assert matches[0].status == TrackMatchStatus.NO_MATCH
    assert matches[0].error == "search blocked"
    assert matches[1].status == TrackMatchStatus.AUTO_MATCHED


def test_no_candidates_means_no_match(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    monkeypatch.setattr(
        pipeline, "fetch_all_playlist_tracks", lambda token, playlist_id: [make_track(1)]
    )
    monkeypatch.setattr(pipeline, "search", lambda query, limit: [])
    monkeypatch.setattr(pipeline, "score_candidates", lambda title, artist, duration_s, results: [])

    run_playlist_import(imp.id)

    match = db_session.scalars(select(TrackMatch)).one()
    assert match.status == TrackMatchStatus.NO_MATCH
    assert match.chosen_url is None
    assert match.confidence is None


def test_missing_account_fails_with_a_clear_message(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    imp.account_id = None
    db_session.commit()

    run_playlist_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.FAILED
    assert "no longer connected" in (imp.error or "")


# ------------------------------------------------- youtube import (ADR-010)


def make_youtube_import(db_session: Session, url: str = "https://youtube.com/playlist?list=X"):
    imp = PlaylistImport(
        service="youtube", account_id=None, external_playlist_id=url, name="YouTube playlist"
    )
    db_session.add(imp)
    db_session.commit()
    db_session.refresh(imp)
    return imp


def test_youtube_import_records_videos_as_matches_and_skips_matching(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_youtube_import(db_session)
    listing = PlaylistListing(
        title="Great Mix",
        entries=[
            PlaylistEntry(url="https://y/1", title="One", uploader="A", duration=100.0),
            PlaylistEntry(url="https://y/2", title="Two", uploader=None, duration=None),
        ],
        announced_count=2,
        skipped=0,
    )
    monkeypatch.setattr(pipeline, "list_playlist", lambda url: listing)

    def _no_search(*args: object, **kwargs: object):
        raise AssertionError("a YouTube import must not run the matching search")

    monkeypatch.setattr(pipeline, "search", _no_search)

    run_playlist_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.REVIEW
    assert imp.name == "Great Mix"  # discovered during the fetch
    assert imp.track_count == 2
    assert imp.matched_count == 2

    matches = db_session.scalars(select(TrackMatch).order_by(TrackMatch.position)).all()
    assert [match.chosen_url for match in matches] == ["https://y/1", "https://y/2"]
    assert all(match.status == TrackMatchStatus.AUTO_MATCHED for match in matches)
    assert matches[0].artist == "A"
    assert matches[1].artist == "Unknown"  # uploader falls back


def test_youtube_import_records_the_playlists_size_not_the_survivors(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#585 — the other half of my "4/4 done" on an eighteen-track import.

    ``list_playlist`` drops an entry it cannot read, and this used to set
    ``track_count`` from the survivors — so the import's own idea of its size
    became "the ones we could read", and everything downstream, phone included,
    was honest about a number that was already wrong.

    ⚠️ Deliberately **not** a refusal, unlike ADR-013's guard for NetEase, QQ
    and Kugou. There a shortfall means the *request* half worked; here it
    usually means the videos are genuinely gone, and refusing would make a
    playlist with one deleted track unimportable.
    """
    imp = make_youtube_import(db_session)
    listing = PlaylistListing(
        title="Great Mix",
        entries=[
            PlaylistEntry(url="https://y/1", title="One", uploader="A", duration=100.0),
        ],
        announced_count=18,
        skipped=17,
    )
    monkeypatch.setattr(pipeline, "list_playlist", lambda url: listing)

    run_playlist_import(imp.id)

    db_session.refresh(imp)
    # The playlist's size…
    assert imp.track_count == 18
    # …and what we actually hold. The pair says "1 of 18"; it used to say
    # "1 of 1", which reads as a complete import of a one-track playlist.
    assert imp.matched_count == 1
    assert len(db_session.scalars(select(TrackMatch)).all()) == 1


def test_youtube_import_cleans_up_auto_generated_channel_names(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#307, from device testing: every imported track showed "- Topic".

    The strings here are real, taken from a live flat listing on 2026-08-05.
    "Release - Topic" is YouTube's generic bucket for an upload with no artist
    channel of its own — so it names nobody, and stripping the suffix would
    leave the word "Release" sitting where an artist should be. That is what
    was reported, and printing it is worse than admitting the artist is unknown.
    """
    imp = make_youtube_import(db_session)
    listing = PlaylistListing(
        title="稻香",
        entries=[
            PlaylistEntry(
                url="https://y/1",
                title="稻香",
                uploader="AnnieTaco安妮塔克 - Topic",
                duration=224.0,
            ),
            PlaylistEntry(
                url="https://y/2", title="稻香", uploader="Release - Topic", duration=1.0
            ),
            PlaylistEntry(
                url="https://y/3",
                title="稻香 Rice Field",
                uploader="周杰倫 Jay Chou",
                duration=224.0,
            ),
        ],
        announced_count=3,
        skipped=0,
    )
    monkeypatch.setattr(pipeline, "list_playlist", lambda url: listing)

    run_playlist_import(imp.id)

    matches = db_session.scalars(select(TrackMatch).order_by(TrackMatch.position)).all()
    assert [match.artist for match in matches] == [
        "AnnieTaco安妮塔克",  # the suffix comes off, the artist survives
        "Unknown",  # named nobody to begin with
        "周杰倫 Jay Chou",  # an ordinary channel is left completely alone
    ]
    # The titles were never the problem, whatever the issue said — they come
    # back from the flat listing intact.
    assert [match.title for match in matches] == ["稻香", "稻香", "稻香 Rice Field"]
    # The candidate keeps the raw channel: it is the machine's record of what
    # was found, and "- Topic" there tells a reviewer what kind of upload it is.
    assert matches[1].candidates[0]["uploader"] == "Release - Topic"


def test_youtube_import_fails_gracefully_when_not_a_playlist(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_youtube_import(db_session, "https://youtu.be/one-video")

    def _raise(url: str) -> PlaylistListing:
        raise ExtractionError("That URL doesn't look like a playlist")

    monkeypatch.setattr(pipeline, "list_playlist", _raise)

    run_playlist_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.FAILED
    assert "playlist" in (imp.error or "")


# ------------------------------------------------- run_confirmed_import


def seed_confirm_match(
    db_session: Session,
    imp: PlaylistImport,
    position: int,
    status: TrackMatchStatus,
    chosen_url: str | None,
) -> TrackMatch:
    row = TrackMatch(
        playlist_import_id=imp.id,
        position=position,
        title=f"Song {position}",
        artist="Artist",
        duration_s=200.0,
        candidates=[],
        chosen_url=chosen_url,
        confidence=0.9,
        status=status,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def start_importing(db_session: Session, imp: PlaylistImport, import_total: int) -> None:
    """Put the import where the confirm endpoint leaves it before scheduling."""
    imp.status = PlaylistImportStatus.IMPORTING
    imp.import_total = import_total
    db_session.commit()


def fake_download(should_fail: frozenset[str] = frozenset()):
    """A run_import_job stand-in that behaves like the real one: it works on
    its own session and commits DONE + a Song row (or FAILED + an error)."""
    calls: list[int] = []

    def _run(job_id: int) -> None:
        calls.append(job_id)
        db = SessionLocal()
        try:
            job = db.get(ImportJob, job_id)
            assert job is not None
            if job.source_url in should_fail:
                job.status = ImportStatus.FAILED
                job.error = "boom"
            else:
                song = Song(
                    title=f"Imported {job_id}",
                    artist="Artist",
                    album=None,
                    duration=200.0,
                    file_path=f"/tmp/{job_id}.opus",
                    file_hash=f"hash-{job_id}",
                    source_url=job.source_url,
                    source_platform="youtube",
                )
                db.add(song)
                db.flush()
                job.song_id = song.id
                job.status = ImportStatus.DONE
            db.commit()
        finally:
            db.close()

    return _run, calls


def fake_download_transient(transient: frozenset[str]):
    """Like fake_download, but for the given urls it parks the job back to
    queued and raises TransientExtractionError — exactly what the real pipeline
    does for a throttling/timeout failure."""

    def _run(job_id: int) -> None:
        db = SessionLocal()
        try:
            job = db.get(ImportJob, job_id)
            assert job is not None
            if job.source_url in transient:
                job.status = ImportStatus.QUEUED
                job.error = "throttled"
                db.commit()
                raise TransientExtractionError("throttled")
            song = Song(
                title=f"Imported {job_id}",
                artist="Artist",
                album=None,
                duration=200.0,
                file_path=f"/tmp/{job_id}.opus",
                file_hash=f"hash-{job_id}",
                source_url=job.source_url,
                source_platform="youtube",
            )
            db.add(song)
            db.flush()
            job.song_id = song.id
            job.status = ImportStatus.DONE
            db.commit()
        finally:
            db.close()

    return _run


class RecordingPacer:
    """Stands in for AdaptivePacer to record how the batch path drives it."""

    def __init__(self) -> None:
        self.events: list[str] = []

    def on_success(self) -> None:
        self.events.append("success")

    def on_transient_failure(self) -> None:
        self.events.append("transient")

    def wait(self) -> None:
        self.events.append("wait")


def test_confirm_phase_drives_the_pacer_per_outcome(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The whole point of B0: adaptive pacing must reach the inline batch path,
    # which is exactly where Celery's rate limit never applied.
    imp = make_import()
    start_importing(db_session, imp, import_total=2)
    seed_confirm_match(db_session, imp, 0, TrackMatchStatus.ACCEPTED, "https://y/ok")
    seed_confirm_match(db_session, imp, 1, TrackMatchStatus.ACCEPTED, "https://y/throttled")
    monkeypatch.setattr(
        pipeline, "run_import_job", fake_download_transient(frozenset({"https://y/throttled"}))
    )
    pacer = RecordingPacer()
    monkeypatch.setattr(pipeline.AdaptivePacer, "from_settings", classmethod(lambda cls: pacer))

    run_confirmed_import(imp.id)

    # A success shrinks, a transient failure grows, and every download is paced.
    assert pacer.events == ["success", "wait", "transient", "wait"]


def fake_download_flaky(fail_until: dict[str, int]):
    """run_import_job stand-in that raises TransientExtractionError for a url
    until it has been called fail_until[url] times, then succeeds. Returns the
    per-url call counts so a test can assert how many attempts happened."""
    calls: dict[str, int] = {}

    def _run(job_id: int) -> None:
        db = SessionLocal()
        try:
            job = db.get(ImportJob, job_id)
            assert job is not None
            calls[job.source_url] = calls.get(job.source_url, 0) + 1
            if calls[job.source_url] <= fail_until.get(job.source_url, 0):
                job.status = ImportStatus.QUEUED
                job.error = "throttled"
                db.commit()
                raise TransientExtractionError("throttled")
            song = Song(
                title=f"Imported {job_id}",
                artist="Artist",
                album=None,
                duration=200.0,
                file_path=f"/tmp/{job_id}.opus",
                file_hash=f"hash-{job_id}",
                source_url=job.source_url,
                source_platform="youtube",
            )
            db.add(song)
            db.flush()
            job.song_id = song.id
            job.status = ImportStatus.DONE
            db.commit()
        finally:
            db.close()

    return _run, calls


def test_confirm_phase_retries_a_transient_failure_then_succeeds(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    # B3: a batch import retries transient failures inline, like a single job.
    imp = make_import()
    start_importing(db_session, imp, import_total=1)
    seed_confirm_match(db_session, imp, 0, TrackMatchStatus.ACCEPTED, "https://y/flaky")
    run, calls = fake_download_flaky({"https://y/flaky": 2})  # fails twice, then works
    monkeypatch.setattr(pipeline, "run_import_job", run)

    run_confirmed_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.DONE
    assert imp.imported_count == 1
    assert imp.failed_count == 0
    assert calls["https://y/flaky"] == 3  # two failures + the recovering attempt
    match = db_session.scalars(select(TrackMatch)).one()
    assert match.status == TrackMatchStatus.IMPORTED


def test_confirm_phase_gives_up_after_max_retries(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    start_importing(db_session, imp, import_total=1)
    seed_confirm_match(db_session, imp, 0, TrackMatchStatus.ACCEPTED, "https://y/throttled")
    run, calls = fake_download_flaky({"https://y/throttled": 99})  # never recovers
    monkeypatch.setattr(pipeline, "run_import_job", run)

    run_confirmed_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.DONE  # a batch still ends done
    assert imp.imported_count == 0
    assert imp.failed_count == 1
    # One initial attempt plus download_max_retries retries, then it gives up.
    assert calls["https://y/throttled"] == get_settings().download_max_retries + 1
    match = db_session.scalars(select(TrackMatch)).one()
    assert match.status == TrackMatchStatus.FAILED


def test_confirm_phase_downloads_and_builds_the_playlist(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    start_importing(db_session, imp, import_total=2)
    seed_confirm_match(db_session, imp, 0, TrackMatchStatus.AUTO_MATCHED, "https://y/0")
    seed_confirm_match(db_session, imp, 1, TrackMatchStatus.REJECTED, "https://y/1")
    seed_confirm_match(db_session, imp, 2, TrackMatchStatus.ACCEPTED, "https://y/2")
    run, calls = fake_download()
    monkeypatch.setattr(pipeline, "run_import_job", run)

    run_confirmed_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.DONE
    assert imp.imported_count == 2
    assert imp.failed_count == 0
    assert imp.playlist_id is not None
    assert len(calls) == 2

    playlist = db_session.get(Playlist, imp.playlist_id)
    assert playlist is not None
    assert playlist.name == "Road Trip"
    items = db_session.scalars(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == playlist.id)
        .order_by(PlaylistItem.position)
    ).all()
    assert [item.position for item in items] == [0, 1]

    matches = {match.position: match for match in db_session.scalars(select(TrackMatch)).all()}
    assert matches[0].status == TrackMatchStatus.IMPORTED
    assert matches[0].song_id == items[0].song_id
    assert matches[2].status == TrackMatchStatus.IMPORTED
    assert matches[1].status == TrackMatchStatus.REJECTED  # untouched


def test_confirm_phase_records_failures_and_continues(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    start_importing(db_session, imp, import_total=2)
    failing = seed_confirm_match(db_session, imp, 0, TrackMatchStatus.AUTO_MATCHED, "https://y/0")
    seed_confirm_match(db_session, imp, 1, TrackMatchStatus.ACCEPTED, "https://y/1")
    run, _calls = fake_download(should_fail=frozenset({"https://y/0"}))
    monkeypatch.setattr(pipeline, "run_import_job", run)

    run_confirmed_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.DONE  # partial success is success
    assert imp.imported_count == 1
    assert imp.failed_count == 1

    db_session.expire_all()
    failed = db_session.get(TrackMatch, failing.id)
    assert failed is not None
    assert failed.status == TrackMatchStatus.FAILED
    assert failed.error == "boom"
    assert failed.import_job_id is not None

    items = db_session.scalars(
        select(PlaylistItem).where(PlaylistItem.playlist_id == imp.playlist_id)
    ).all()
    assert [item.position for item in items] == [0]  # dense despite the gap


def test_confirm_phase_reuses_existing_library_songs(
    db_session: Session, make_import, install_id: int, monkeypatch: pytest.MonkeyPatch
) -> None:
    existing = Song(
        title="Already Here",
        artist="Artist",
        album=None,
        duration=100.0,
        file_path="/tmp/existing.opus",
        file_hash="hash-existing",
        source_url="https://y/0",
        source_platform="youtube",
        # Same owner as the import: reuse is deliberately scoped to one owner, so
        # an unowned song here would (correctly) not be reused.
        owner_install_id=install_id,
    )
    db_session.add(existing)
    db_session.commit()
    db_session.refresh(existing)

    imp = make_import()
    start_importing(db_session, imp, import_total=1)
    match = seed_confirm_match(db_session, imp, 0, TrackMatchStatus.AUTO_MATCHED, "https://y/0")

    def _must_not_download(job_id: int) -> None:
        raise AssertionError("an already-imported source must not be downloaded again")

    monkeypatch.setattr(pipeline, "run_import_job", _must_not_download)

    run_confirmed_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.imported_count == 1
    reused = db_session.get(TrackMatch, match.id)
    assert reused is not None
    assert reused.status == TrackMatchStatus.IMPORTED
    assert reused.song_id == existing.id
    assert db_session.scalars(select(ImportJob)).all() == []


# ------------------------------------------------- fail_interrupted_imports


def test_restart_sweep_fails_midrun_imports_only(db_session: Session, make_import) -> None:
    statuses = [
        PlaylistImportStatus.QUEUED,
        PlaylistImportStatus.FETCHING,
        PlaylistImportStatus.MATCHING,
        PlaylistImportStatus.IMPORTING,
        PlaylistImportStatus.REVIEW,
        PlaylistImportStatus.DONE,
    ]
    rows = {}
    for status in statuses:
        row = make_import()
        row.status = status
        rows[status] = row
    db_session.commit()

    fail_interrupted_imports()

    db_session.expire_all()
    for status in statuses[:4]:
        swept = db_session.get(PlaylistImport, rows[status].id)
        assert swept is not None
        assert swept.status == PlaylistImportStatus.FAILED
        assert "restart" in (swept.error or "")
    # `review` waits on a person, `done` already finished — both untouched.
    assert (
        db_session.get(PlaylistImport, rows[PlaylistImportStatus.REVIEW].id).status
        == PlaylistImportStatus.REVIEW
    )
    assert (
        db_session.get(PlaylistImport, rows[PlaylistImportStatus.DONE].id).status
        == PlaylistImportStatus.DONE
    )


# ------------------------------------------------- run_retry_failed_matches


def test_retry_recovers_a_previously_failed_track(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point: transient failures shouldn't need a fresh import."""
    imp = make_import()
    playlist = Playlist(name="Road Trip")
    db_session.add(playlist)
    db_session.flush()
    imp.playlist_id = playlist.id
    imp.status = PlaylistImportStatus.DONE
    imp.import_total = 2
    imp.imported_count = 1
    imp.failed_count = 1
    ok = seed_confirm_match(db_session, imp, 0, TrackMatchStatus.IMPORTED, "https://y/0")
    failed = seed_confirm_match(db_session, imp, 1, TrackMatchStatus.FAILED, "https://y/1")
    failed.error = "HTTP Error 403: Forbidden"
    db_session.add(PlaylistItem(playlist_id=playlist.id, song_id=None or 1, position=0))
    db_session.commit()
    run, calls = fake_download()
    monkeypatch.setattr(pipeline, "run_import_job", run)

    run_retry_failed_matches(imp.id, [failed.id])

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.DONE
    assert imp.imported_count == 2  # counters are recomputed, not incremented
    assert imp.failed_count == 0
    assert len(calls) == 1  # only the failed one was downloaded

    recovered = db_session.get(TrackMatch, failed.id)
    assert recovered is not None
    assert recovered.status == TrackMatchStatus.IMPORTED
    assert recovered.error is None  # the stale 403 is cleared
    assert db_session.get(TrackMatch, ok.id).status == TrackMatchStatus.IMPORTED


def test_retry_appends_to_the_existing_playlist(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    playlist = Playlist(name="Road Trip")
    db_session.add(playlist)
    db_session.flush()
    imp.playlist_id = playlist.id
    imp.status = PlaylistImportStatus.DONE
    db_session.add(PlaylistItem(playlist_id=playlist.id, song_id=1, position=0))
    failed = seed_confirm_match(db_session, imp, 1, TrackMatchStatus.FAILED, "https://y/1")
    db_session.commit()
    run, _calls = fake_download()
    monkeypatch.setattr(pipeline, "run_import_job", run)

    run_retry_failed_matches(imp.id, [failed.id])

    items = db_session.scalars(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == playlist.id)
        .order_by(PlaylistItem.position)
    ).all()
    assert [item.position for item in items] == [0, 1]  # appended, not renumbered


def test_retry_that_fails_again_leaves_the_row_failed(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    playlist = Playlist(name="Road Trip")
    db_session.add(playlist)
    db_session.flush()
    imp.playlist_id = playlist.id
    imp.status = PlaylistImportStatus.DONE
    failed = seed_confirm_match(db_session, imp, 0, TrackMatchStatus.FAILED, "https://y/0")
    db_session.commit()
    run, _calls = fake_download(should_fail=frozenset({"https://y/0"}))
    monkeypatch.setattr(pipeline, "run_import_job", run)

    run_retry_failed_matches(imp.id, [failed.id])

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.DONE
    assert imp.failed_count == 1
    assert db_session.get(TrackMatch, failed.id).status == TrackMatchStatus.FAILED


def test_retry_ignores_matches_that_are_not_failed(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Guards against re-downloading a track that already worked."""
    imp = make_import()
    playlist = Playlist(name="Road Trip")
    db_session.add(playlist)
    db_session.flush()
    imp.playlist_id = playlist.id
    imp.status = PlaylistImportStatus.DONE
    imported = seed_confirm_match(db_session, imp, 0, TrackMatchStatus.IMPORTED, "https://y/0")
    db_session.commit()

    def _must_not_download(job_id: int) -> None:
        raise AssertionError("a successful track must not be downloaded again")

    monkeypatch.setattr(pipeline, "run_import_job", _must_not_download)

    run_retry_failed_matches(imp.id, [imported.id])

    assert reload_import(db_session, imp.id).status == PlaylistImportStatus.DONE


def test_youtube_import_stores_a_thumbnail_for_the_review_row(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#312: the review page shows a picture, and it costs no extra request.

    The flat listing already carries it, so this is a field being kept rather
    than a lookup being added — which matters, because one request per track is
    exactly what the server cannot afford (#177).
    """
    imp = make_youtube_import(db_session)
    listing = PlaylistListing(
        title="Great Mix",
        entries=[
            PlaylistEntry(
                url="https://y/1",
                title="One",
                uploader="A",
                duration=100.0,
                thumbnail="https://i.ytimg.com/vi/1/hq.jpg",
            ),
            PlaylistEntry(url="https://y/2", title="Two", uploader=None, duration=None),
        ],
        announced_count=2,
        skipped=0,
    )
    monkeypatch.setattr(pipeline, "list_playlist", lambda url: listing)

    run_playlist_import(imp.id)

    matches = db_session.scalars(select(TrackMatch).order_by(TrackMatch.position)).all()
    assert matches[0].candidates[0]["thumbnail"] == "https://i.ytimg.com/vi/1/hq.jpg"
    # Absent rather than missing: a video with no artwork is ordinary, and the
    # client draws its placeholder.
    assert matches[1].candidates[0]["thumbnail"] is None


def test_spotify_import_carries_the_thumbnail_through_the_matcher(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    imp = make_import()
    monkeypatch.setattr(
        pipeline, "fetch_all_playlist_tracks", lambda token, playlist_id: [make_track(1)]
    )
    monkeypatch.setattr(pipeline, "search", lambda query, limit: [make_result(1)])
    monkeypatch.setattr(
        pipeline,
        "score_candidates",
        lambda title, artist, duration_s, results: [
            ScoredCandidate(
                url="https://www.youtube.com/watch?v=1",
                title="Song 1",
                uploader="Artist",
                duration=200.0,
                score=0.9,
                thumbnail="https://i.ytimg.com/vi/1/hq.jpg",
            )
        ],
    )

    run_playlist_import(imp.id)

    match = db_session.scalars(select(TrackMatch)).one()
    # Stored with `asdict`, so a field added to the dataclass reaches the client
    # without anything here being told about it — which is the point of picking
    # the candidates up that way.
    assert match.candidates[0]["thumbnail"] == "https://i.ytimg.com/vi/1/hq.jpg"


def test_a_client_matching_run_fetches_then_stops(
    db_session: Session, make_import, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#353: the tracklist still comes from Spotify, the searching does not happen here.

    The server cannot search YouTube from a datacenter — 1 request in 14 (#177) —
    so a run flagged `client_matches` stops in MATCHING and waits for
    `POST /{id}/candidates`. The assertion that matters is the *absence*: a
    version that searched anyway would still reach review and look fine.
    """
    imp = make_import(client_matches=True)
    monkeypatch.setattr(
        pipeline,
        "fetch_all_playlist_tracks",
        lambda token, playlist_id: [make_track(1), make_track(2)],
    )

    def refuse(query: str, limit: int):
        raise AssertionError("the server must not search YouTube for a client-matching run")

    monkeypatch.setattr(pipeline, "search", refuse)

    run_playlist_import(imp.id)

    imp = reload_import(db_session, imp.id)
    assert imp.status == PlaylistImportStatus.MATCHING
    # The Spotify half still ran: the tracks are there, waiting to be matched.
    assert imp.track_count == 2
    assert imp.matched_count == 0
    matches = db_session.scalars(
        select(TrackMatch).where(TrackMatch.playlist_import_id == imp.id)
    ).all()
    assert len(matches) == 2
    assert all(match.status == TrackMatchStatus.PENDING for match in matches)
