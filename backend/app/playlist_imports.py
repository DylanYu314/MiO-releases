"""The playlist-import pipelines: fetch and match, download, and retry.

Mirrors app/jobs.py — plain sync functions, run by a Celery worker, that own
their session and record every failure on the row instead of raising. Spotify
is only contacted during FETCHING; from MATCHING onward an expired token or
lapsed Premium can no longer affect the run (ADR-005).
"""

import logging
import time
from dataclasses import asdict

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.events import playlist_import_events
from app.installs import owned_by
from app.jobs import run_import_job
from app.matching import CANDIDATE_LIMIT, build_search_query, classify, score_candidates
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
from app.pacing import AdaptivePacer, retry_backoff_seconds
from app.schemas import PlaylistImportRead
from app.spotify import SpotifyError, fetch_all_playlist_tracks, fetch_all_saved_tracks
from app.spotify_accounts import get_fresh_access_token
from app.ytdlp import (
    ExtractionError,
    SearchResult,
    TransientExtractionError,
    display_artist,
    list_playlist,
    search,
)

logger = logging.getLogger(__name__)

# external_playlist_id sentinel for the user's Liked Songs.
LIKED_SONGS_ID = "liked"

# Match statuses the confirm phase will download.
IMPORTABLE_STATUSES = {TrackMatchStatus.AUTO_MATCHED, TrackMatchStatus.ACCEPTED}

# Import statuses that mean "the server was mid-run" — as opposed to `review`,
# which waits on a person and survives restarts untouched.
INTERRUPTIBLE_STATUSES = (
    PlaylistImportStatus.QUEUED,
    PlaylistImportStatus.FETCHING,
    PlaylistImportStatus.MATCHING,
    PlaylistImportStatus.IMPORTING,
)


def publish_import(imp: PlaylistImport) -> None:
    """Tell WebSocket listeners the run moved.

    Public since #353: the candidates endpoint advances an import from a request
    handler rather than from the pipeline, and a review screen watching the
    socket should not have to poll to notice.
    """
    playlist_import_events.publish(
        imp.id, PlaylistImportRead.model_validate(imp).model_dump(mode="json")
    )


def _advance(imp: PlaylistImport, status: PlaylistImportStatus, db: Session) -> None:
    """Move the import to `status`, persist it, then tell WebSocket listeners.
    Commit first — the DB is the source of truth (ADR-004)."""
    imp.status = status
    db.commit()
    db.refresh(imp)
    logger.info(
        "playlist import status",
        extra={
            "playlist_import_id": imp.id,
            "status": status.value,
            "imported": imp.imported_count,
            "failed": imp.failed_count,
        },
    )
    publish_import(imp)


def run_playlist_import(playlist_import_id: int) -> None:
    """Drive an import to `review` (or `failed`). Dispatches on the source:
    Spotify fetches then matches; YouTube just fetches (its entries are already
    videos, so there's nothing to match) — see ADR-010.

    One run does **not** reach review here: a Spotify import flagged
    `client_matches` stops after fetching, because the searching happens on the
    phone (#353). `POST /playlist-imports/{id}/candidates` finishes it."""
    db = SessionLocal()
    try:
        imp = db.get(PlaylistImport, playlist_import_id)
        if imp is None:
            return

        try:
            if imp.service == "youtube":
                _fetch_youtube_playlist(imp, db)
            else:
                _fetch_and_match_spotify(imp, db)
            # A client-matching run is not finished when this returns — it has
            # fetched the tracklist and is waiting for the phone to post what it
            # found (#353). `POST /{id}/candidates` is what moves it to review,
            # once every track has been answered for.
            if not imp.client_matches:
                _advance(imp, PlaylistImportStatus.REVIEW, db)
        except Exception as exc:
            logger.exception("playlist import failed", extra={"error": str(exc)})
            imp.error = str(exc)
            _advance(imp, PlaylistImportStatus.FAILED, db)
    finally:
        db.close()


def _fetch_and_match_spotify(imp: PlaylistImport, db: Session) -> None:
    settings = get_settings()
    account = db.get(SpotifyAccount, imp.account_id) if imp.account_id else None
    if account is None:
        raise SpotifyError("The Spotify account for this import is no longer connected")

    _advance(imp, PlaylistImportStatus.FETCHING, db)
    token = get_fresh_access_token(db, account, settings.spotify_client_id or "")
    if imp.external_playlist_id == LIKED_SONGS_ID:
        tracks = fetch_all_saved_tracks(token)
    else:
        tracks = fetch_all_playlist_tracks(token, imp.external_playlist_id)

    for position, track in enumerate(tracks):
        db.add(
            TrackMatch(
                playlist_import_id=imp.id,
                position=position,
                external_id=track.external_id,
                title=track.title,
                artist=track.artist,
                album=track.album,
                duration_s=track.duration_s,
            )
        )
    imp.track_count = len(tracks)
    logger.info("fetched tracks from spotify", extra={"track_count": len(tracks)})
    # Spotify's part ends here — nothing below needs the token.
    _advance(imp, PlaylistImportStatus.MATCHING, db)

    # The client is doing the searching, so the run stops here (#353).
    #
    # It stays in MATCHING rather than gaining a status of its own: from the
    # outside "matching" is exactly what is happening, and the only difference
    # is which machine is doing it. `POST /{id}/candidates` drives the rest, and
    # the startup sweep already treats a stalled MATCHING run as interrupted.
    if imp.client_matches:
        logger.info("waiting for client-supplied candidates", extra={"import_id": imp.id})
        return

    matches = db.scalars(
        select(TrackMatch)
        .where(TrackMatch.playlist_import_id == imp.id)
        .order_by(TrackMatch.position)
    ).all()
    for match in matches:
        try:
            results = search(build_search_query(match.title, match.artist), CANDIDATE_LIMIT)
        except ExtractionError as exc:
            # One unsearchable track degrades that row, never the run.
            logger.warning(
                "track search failed",
                extra={"track": match.title, "artist": match.artist, "error": str(exc)},
            )
            match.status = TrackMatchStatus.NO_MATCH
            match.error = str(exc)
        else:
            record_candidates(match, results)
        imp.matched_count += 1
        db.commit()
        db.refresh(imp)
        publish_import(imp)


def record_candidates(match: TrackMatch, results: list[SearchResult]) -> None:
    """Score `results` against `match` and write the outcome onto the row.

    Split out of the matching loop by #353 so that candidates found **on a
    phone** are scored by exactly the same code as candidates the server found
    itself. That is the whole point of the design: the search moves, because
    only a residential address is allowed to do it, and the scorer does not,
    because there is no reason for it to and two scorers would drift.

    Pure apart from the assignment — no session, no network — so it is callable
    from the pipeline and from a request handler alike.
    """
    scored = score_candidates(match.title, match.artist, match.duration_s, results)
    match.candidates = [asdict(candidate) for candidate in scored]
    if scored:
        match.chosen_url = scored[0].url
        match.confidence = scored[0].score
    # Cleared on purpose: a row being re-matched after a failure kept its old
    # message, so a track that succeeded on the second attempt still showed the
    # reason the first one failed.
    match.error = None
    match.status = classify(scored[0].score if scored else None)


def _fetch_youtube_playlist(imp: PlaylistImport, db: Session) -> None:
    """List a public YouTube playlist and record each video as an already-matched
    track — no search stage. The confirm/download chain then runs unchanged."""
    _advance(imp, PlaylistImportStatus.FETCHING, db)
    listing = list_playlist(imp.external_playlist_id)
    if listing.title:
        imp.name = listing.title

    for position, entry in enumerate(listing.entries):
        db.add(
            TrackMatch(
                playlist_import_id=imp.id,
                position=position,
                external_id=None,
                title=entry.title,
                # Not the raw channel: an auto-generated Topic channel is
                # "<Artist> - Topic", and some of them name nobody at all (#307).
                artist=display_artist(entry.uploader) or "Unknown",
                album=None,
                duration_s=entry.duration,
                # The video is its own (single) candidate; no machine confidence.
                candidates=[
                    {
                        "url": entry.url,
                        "title": entry.title,
                        "uploader": entry.uploader,
                        "duration": entry.duration,
                        "thumbnail": entry.thumbnail,
                        "score": None,
                    }
                ],
                chosen_url=entry.url,
                confidence=None,
                status=TrackMatchStatus.AUTO_MATCHED,
            )
        )
    # ⚠️ The playlist's size, not the number of entries that survived (#585).
    #
    # `list_playlist` drops an entry with no title — which is what a deleted,
    # private or region-blocked video looks like to flat extraction — and this
    # line used to record the survivors as the import's own total. An
    # eighteen-track playlist then *was* a four-track import as far as anything
    # downstream could tell, and the phone honestly reported "4/4 done" about a
    # number that had already been redefined.
    #
    # `matched_count` stays the entries we actually hold, so the pair now says
    # "4 of 18" rather than "4 of 4".
    imp.track_count = listing.announced_count
    imp.matched_count = len(listing.entries)
    if listing.skipped:
        # Warning, not info: this is the difference between the playlist the
        # user is looking at and the one they are about to import, and it is the
        # only place that difference is observable.
        #
        # Not raised. ADR-013 refuses a short read for NetEase, QQ and Kugou,
        # and rightly — there a shortfall means the *request* half worked. Here
        # it usually means the videos are genuinely gone, and refusing would
        # make a playlist with one deleted track unimportable. So: report.
        logger.warning(
            "youtube playlist entries skipped",
            extra={
                "announced": listing.announced_count,
                "usable": len(listing.entries),
                "skipped": listing.skipped,
            },
        )
    logger.info("fetched youtube playlist", extra={"track_count": len(listing.entries)})


def _recount(imp: PlaylistImport, db: Session) -> None:
    """Recompute the progress counters from the rows themselves.

    Derived rather than incremented, so a retry that turns a failure into a
    success can't leave the totals lying.
    """
    # Sessions here are autoflush=False, so the status just set on the row in
    # memory has to reach the database before we count rows in it.
    db.flush()
    counts = dict(
        db.execute(
            select(TrackMatch.status, func.count())
            .where(TrackMatch.playlist_import_id == imp.id)
            .group_by(TrackMatch.status)
        ).all()
    )
    imp.imported_count = counts.get(TrackMatchStatus.IMPORTED, 0)
    imp.failed_count = counts.get(TrackMatchStatus.FAILED, 0)


def _next_playlist_position(playlist_id: int, db: Session) -> int:
    highest = db.scalar(
        select(func.max(PlaylistItem.position)).where(PlaylistItem.playlist_id == playlist_id)
    )
    return 0 if highest is None else highest + 1


def _import_match(
    match: TrackMatch, imp: PlaylistImport, db: Session, pacer: AdaptivePacer
) -> None:
    """Download one accepted match and, on success, append it to the playlist.

    Shared by the first confirmed run and by retries, so both behave
    identically. Records failures on the row and returns — a bad track never
    stops the batch. The `pacer` carries the adaptive inter-download delay
    across calls in a batch (B0).
    """
    song_id = None
    if match.chosen_url is None:
        match.status = TrackMatchStatus.FAILED
        match.error = "No chosen URL"
    else:
        # Reuse a song that's already in the library (same source) instead of
        # downloading the same audio twice.
        # Only reuse a song this same owner already has: matching on URL alone
        # would hand one person's file to another's playlist (#170).
        existing = db.scalar(
            select(Song).where(
                Song.source_url == match.chosen_url,
                owned_by(Song, imp.owner_install_id),
            )
        )
        if existing is not None:
            song_id = existing.id
        else:
            job = ImportJob(
                source_url=match.chosen_url,
                status=ImportStatus.QUEUED,
                owner_install_id=imp.owner_install_id,
            )
            db.add(job)
            # Commit ends our transaction before the inline call: run_import_job
            # commits on its own session, and two sessions must never hold
            # SQLite write locks at once.
            db.commit()
            # Single jobs get their retries from the Celery task layer, but a
            # batch calls the pipeline inline — so retry transient failures here
            # too, with the same bounded backoff, instead of failing the track
            # on the first throttle (B3).
            max_retries = get_settings().download_max_retries
            hit_transient = False
            for attempt in range(max_retries + 1):
                try:
                    run_import_job(job.id)
                    break  # returned (DONE, or a permanent failure it recorded)
                except TransientExtractionError as exc:
                    hit_transient = True
                    if attempt >= max_retries:
                        logger.warning(
                            "giving up on track after retries",
                            extra={
                                "track": match.title,
                                "attempts": attempt + 1,
                                "error": str(exc),
                            },
                        )
                        break
                    delay = retry_backoff_seconds(attempt)
                    logger.info(
                        "retrying track after transient failure",
                        extra={
                            "track": match.title,
                            "attempt": attempt + 1,
                            "retry_in_seconds": delay,
                        },
                    )
                    time.sleep(delay)

            db.expire_all()
            db.refresh(job)
            match.import_job_id = job.id
            if job.status == ImportStatus.DONE and job.song_id is not None:
                song_id = job.song_id
            else:
                match.status = TrackMatchStatus.FAILED
                match.error = job.error or "Download failed"
            # Pacer (B0): a clean download speeds us up; any throttling we saw —
            # even if we recovered from it — says back off; a private/removed
            # video is neutral, since it says nothing about the rate.
            if hit_transient:
                pacer.on_transient_failure()
            elif job.status == ImportStatus.DONE:
                pacer.on_success()
            pacer.wait()

    if song_id is not None:
        logger.info(
            "track imported",
            extra={"track": match.title, "song_id": song_id, "position": match.position},
        )
        match.song_id = song_id
        match.status = TrackMatchStatus.IMPORTED
        match.error = None
        db.add(
            PlaylistItem(
                playlist_id=imp.playlist_id,
                song_id=song_id,
                position=_next_playlist_position(imp.playlist_id, db),
            )
        )

    _recount(imp, db)
    db.commit()
    db.refresh(imp)
    publish_import(imp)


def run_confirmed_import(playlist_import_id: int) -> None:
    """Phase two: download every accepted match through the Phase-1 pipeline
    and mirror the successes into a new local playlist.

    Sequential on purpose — polite to YouTube, and the rate limit on the job
    task paces it further. Per-track failures are recorded on the row and
    skipped; the run always ends `done` unless the orchestration itself blows
    up (partial success is success, and visible).
    """
    db = SessionLocal()
    try:
        imp = db.get(PlaylistImport, playlist_import_id)
        if imp is None:
            return

        try:
            playlist = Playlist(name=imp.name, owner_install_id=imp.owner_install_id)
            db.add(playlist)
            db.flush()
            imp.playlist_id = playlist.id
            db.commit()
            db.refresh(imp)
            publish_import(imp)

            matches = db.scalars(
                select(TrackMatch)
                .where(
                    TrackMatch.playlist_import_id == imp.id,
                    TrackMatch.status.in_(IMPORTABLE_STATUSES),
                )
                .order_by(TrackMatch.position)
            ).all()

            pacer = AdaptivePacer.from_settings()
            for match in matches:
                _import_match(match, imp, db, pacer)

            _advance(imp, PlaylistImportStatus.DONE, db)
        except Exception as exc:
            logger.exception("playlist import failed", extra={"error": str(exc)})
            imp.error = str(exc)
            _advance(imp, PlaylistImportStatus.FAILED, db)
    finally:
        db.close()


def run_retry_failed_matches(playlist_import_id: int, match_ids: list[int]) -> None:
    """Have another go at tracks that failed to download.

    Most download failures are transient (throttling), so this exists to make
    them recoverable without re-importing the whole playlist. Recovered songs
    are appended to the playlist the import already created.
    """
    db = SessionLocal()
    try:
        imp = db.get(PlaylistImport, playlist_import_id)
        if imp is None or imp.playlist_id is None:
            return

        try:
            matches = db.scalars(
                select(TrackMatch)
                .where(
                    TrackMatch.playlist_import_id == imp.id,
                    TrackMatch.id.in_(match_ids),
                    TrackMatch.status == TrackMatchStatus.FAILED,
                )
                .order_by(TrackMatch.position)
            ).all()
            if not matches:
                _advance(imp, PlaylistImportStatus.DONE, db)
                return

            # Back to accepted while they're in flight, so the counters (and
            # the progress bar) describe what's actually happening.
            for match in matches:
                match.status = TrackMatchStatus.ACCEPTED
                match.error = None
            _recount(imp, db)
            db.commit()
            db.refresh(imp)
            publish_import(imp)

            pacer = AdaptivePacer.from_settings()
            for match in matches:
                _import_match(match, imp, db, pacer)

            _advance(imp, PlaylistImportStatus.DONE, db)
        except Exception as exc:
            logger.exception("playlist import failed", extra={"error": str(exc)})
            imp.error = str(exc)
            _advance(imp, PlaylistImportStatus.FAILED, db)
    finally:
        db.close()


def fail_interrupted_imports() -> None:
    """Mark imports that were mid-run when the server last stopped as failed.

    Celery redelivers *queued* work after a crash, but whatever a worker was
    running when it died is gone. Without this sweep (called from the lifespan
    handler) such an import would sit in a non-terminal state forever, looking
    alive.
    """
    db = SessionLocal()
    try:
        stuck = db.scalars(
            select(PlaylistImport).where(PlaylistImport.status.in_(INTERRUPTIBLE_STATUSES))
        ).all()
        for imp in stuck:
            imp.error = "Interrupted by a server restart"
            imp.status = PlaylistImportStatus.FAILED
        if stuck:
            db.commit()
    finally:
        db.close()
