"""Playlist imports: create import runs, inspect them, stream their progress.

The GET endpoints work without Spotify configuration on purpose — import
history must stay browsable after the Premium window ends (ADR-005).
"""

from typing import Literal

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.access_keys import require_unlock_key
from app.config import Settings
from app.db import SessionLocal, get_db
from app.events import playlist_import_events
from app.installs import current_owner, owned_by, require_install, resolve_install_id
from app.models import (
    PlaylistImport,
    PlaylistImportStatus,
    SpotifyAccount,
    TrackMatch,
    TrackMatchStatus,
)
from app.playlist_imports import IMPORTABLE_STATUSES, publish_import, record_candidates
from app.routers.spotify import require_spotify_settings
from app.schemas import (
    CandidatesSubmission,
    ConfirmImportRequest,
    ExternalPlaylistImportCreate,
    Page,
    PlaylistImportCreate,
    PlaylistImportRead,
    TrackMatchBulkUpdate,
    TrackMatchRead,
    TrackMatchUpdate,
    YouTubePlaylistImportCreate,
)
from app.tasks import confirmed_import_task, playlist_import_task, retry_failed_matches_task
from app.ytdlp import SearchResult

router = APIRouter(prefix="/playlist-imports", tags=["playlist-imports"])

TERMINAL_STATUSES = {PlaylistImportStatus.DONE, PlaylistImportStatus.FAILED}

# A worker is actively writing to these, so they can't be deleted or retried.
RUNNING_STATUSES = {
    PlaylistImportStatus.FETCHING,
    PlaylistImportStatus.MATCHING,
    PlaylistImportStatus.IMPORTING,
}

WS_CLOSE_IMPORT_NOT_FOUND = 4004


def _get_import_or_404(db: Session, import_id: int, owner_install_id: int | None) -> PlaylistImport:
    """Someone else's import answers 404, not 403 — a 403 confirms it exists."""
    playlist_import = db.scalar(
        select(PlaylistImport).where(
            PlaylistImport.id == import_id, owned_by(PlaylistImport, owner_install_id)
        )
    )
    if playlist_import is None:
        raise HTTPException(status_code=404, detail="Playlist import not found")
    return playlist_import


@router.post("", response_model=PlaylistImportRead, status_code=201)
def create_playlist_import(
    payload: PlaylistImportCreate,
    db: Session = Depends(get_db),
    settings: Settings = Depends(require_spotify_settings),
    _: None = Depends(require_unlock_key),
    owner_install_id: int = Depends(require_install),
) -> PlaylistImport:
    account = db.get(SpotifyAccount, payload.account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Spotify account not found")

    playlist_import = PlaylistImport(
        service="spotify",
        account_id=account.id,
        external_playlist_id=payload.playlist_id,
        name=payload.name,
        status=PlaylistImportStatus.QUEUED,
        owner_install_id=owner_install_id,
        # #353: when true the pipeline fetches the tracklist and stops, and
        # `POST /{id}/candidates` finishes the job with what the phone found.
        client_matches=payload.client_matches,
    )
    db.add(playlist_import)
    db.commit()
    db.refresh(playlist_import)
    playlist_import_task.delay(playlist_import.id)
    return playlist_import


@router.post("/youtube", response_model=PlaylistImportRead, status_code=201)
def create_youtube_import(
    payload: YouTubePlaylistImportCreate,
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
    owner_install_id: int = Depends(require_install),
) -> PlaylistImport:
    """Import a public YouTube playlist by URL (ADR-010). Needs no Spotify
    configuration; the real playlist name is discovered during the fetch, so we
    start with a placeholder."""
    playlist_import = PlaylistImport(
        service="youtube",
        account_id=None,
        external_playlist_id=payload.url,
        name="YouTube playlist",
        status=PlaylistImportStatus.QUEUED,
        owner_install_id=owner_install_id,
        # Deliberately not `client_matches`: a YouTube playlist has no matching
        # phase at all, because each entry is already its own candidate
        # (ADR-010). There is nothing here for a client to search for.
    )
    db.add(playlist_import)
    db.commit()
    db.refresh(playlist_import)
    playlist_import_task.delay(playlist_import.id)
    return playlist_import


@router.post("/external", response_model=PlaylistImportRead, status_code=201)
def create_external_import(
    payload: ExternalPlaylistImportCreate,
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
    owner_install_id: int = Depends(require_install),
) -> PlaylistImport:
    """Start an import from a track list the client fetched itself (ADR-013).

    NetEase, QQ Music and Kugou. All three answer a plain unauthenticated HTTP
    request with a whole playlist's titles, artists, durations and albums — and
    the phone makes that request, not this server. Two reasons, both already
    paid for once: whether a Frankfurt address can read a Chinese music API is
    unmeasured and does not need to be if the user's own connection is the one
    asking (#177 is what happens when it does); and these endpoints are
    undocumented, so a break is better fixed in JavaScript, which ships over the
    air in a minute (#412), than in a droplet deploy.

    What stays here is `matching.py`. The phone searches YouTube and posts what
    it found to `POST /{id}/candidates`, and this server scores it — the #353
    split, unchanged, so there is never a second matcher to drift from this one.

    ## Why this starts at `matching` rather than `queued`

    There is no fetch phase to run: it already happened, on the device. So this
    writes the `TrackMatch` rows the fetch phase would have written and lands in
    exactly the state `_fetch_and_match_spotify` leaves a `client_matches` run
    in — which is what makes every later endpoint work unchanged, including the
    startup sweep that treats a stalled `matching` run as interrupted.

    **No task is enqueued.** Nothing on the server has work to do until the
    phone comes back with candidates.

    ## A guess is being made, so these keep the review step

    Unlike a YouTube playlist, where each entry *is* the video (ADR-010,
    ADR-014), a NetEase track is a title and an artist and the video for it has
    to be found. That is what `TrackMatch.confidence` and the review screen are
    for, and it is why this must not be pointed at `listImport.ts`, whose loop
    walks a list of exact ids.
    """
    playlist_import = PlaylistImport(
        service=payload.service,
        account_id=None,
        external_playlist_id=payload.source_url,
        name=payload.name,
        status=PlaylistImportStatus.MATCHING,
        track_count=len(payload.tracks),
        owner_install_id=owner_install_id,
        # Always: the tracks arrived from a client, so the candidates will too.
        client_matches=True,
    )
    db.add(playlist_import)
    db.flush()

    db.add_all(
        [
            TrackMatch(
                playlist_import_id=playlist_import.id,
                position=position,
                external_id=track.external_id,
                title=track.title,
                artist=track.artist,
                album=track.album,
                duration_s=track.duration_s,
                status=TrackMatchStatus.PENDING,
            )
            for position, track in enumerate(payload.tracks)
        ]
    )
    db.commit()
    db.refresh(playlist_import)
    # Deliberately no `publish_import`: the progress socket is per import id, so
    # nobody can be subscribed to one that did not exist a moment ago. The two
    # sibling create endpoints don't publish either.
    return playlist_import


@router.get("", response_model=Page[PlaylistImportRead])
def list_playlist_imports(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> Page[PlaylistImportRead]:
    total = (
        db.scalar(
            select(func.count())
            .select_from(PlaylistImport)
            .where(owned_by(PlaylistImport, owner_install_id))
        )
        or 0
    )
    imports = db.scalars(
        select(PlaylistImport)
        .where(owned_by(PlaylistImport, owner_install_id))
        .order_by(PlaylistImport.created_at.desc(), PlaylistImport.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return Page[PlaylistImportRead](
        items=[PlaylistImportRead.model_validate(imp) for imp in imports],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{import_id}", response_model=PlaylistImportRead)
def get_playlist_import(
    import_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> PlaylistImport:
    return _get_import_or_404(db, import_id, owner_install_id)


@router.get("/{import_id}/matches", response_model=Page[TrackMatchRead])
def list_track_matches(
    import_id: int,
    status: TrackMatchStatus | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> Page[TrackMatchRead]:
    _get_import_or_404(db, import_id, owner_install_id)
    filters = [TrackMatch.playlist_import_id == import_id]
    if status is not None:
        filters.append(TrackMatch.status == status)

    total = db.scalar(select(func.count()).select_from(TrackMatch).where(*filters)) or 0
    matches = db.scalars(
        select(TrackMatch).where(*filters).order_by(TrackMatch.position).limit(limit).offset(offset)
    ).all()
    return Page[TrackMatchRead](
        items=[TrackMatchRead.model_validate(match) for match in matches],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/{import_id}/candidates", response_model=PlaylistImportRead)
def submit_candidates(
    import_id: int,
    payload: CandidatesSubmission,
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
    owner_install_id: int = Depends(require_install),
) -> PlaylistImport:
    """Score candidates a client found for itself (#353).

    The half of the import that had to move. Adding music has fetched its audio
    on the device since #246, but a Spotify import still needed the *server* to
    find each track on YouTube — and YouTube refuses the droplet on every
    client, measured at 1 request in 14 (#177). A phone is on a residential
    connection and is not refused.

    So the phone searches and posts what it found, and this scores it with the
    same `score_candidates` the server-side matching phase uses. **The search
    moved; the matcher did not.** A second matcher in TypeScript would have to
    agree with this one forever, and nothing would tell us when it stopped.

    Idempotent by construction: re-submitting a track re-scores it and
    overwrites the row, so a phone that lost its connection half way through can
    simply send the batch again. `matched_count` is recomputed from the rows
    rather than incremented, which is what makes that safe — incrementing would
    count a resent track twice and leave the run stuck short of its total.
    """
    playlist_import = _get_import_or_404(db, import_id, owner_install_id)

    if playlist_import.status != PlaylistImportStatus.MATCHING:
        raise HTTPException(
            status_code=409,
            detail="Candidates can only be supplied while the import is matching",
        )

    matches = {
        match.id: match
        for match in db.scalars(
            select(TrackMatch).where(TrackMatch.playlist_import_id == import_id)
        )
    }
    # All or nothing on identity: a body naming a track from somebody else's
    # import is a bug or an attack, and silently skipping it would make the
    # first look like the second's success.
    unknown = [track.match_id for track in payload.tracks if track.match_id not in matches]
    if unknown:
        raise HTTPException(status_code=404, detail=f"Unknown match ids: {unknown}")

    for track in payload.tracks:
        record_candidates(
            matches[track.match_id],
            [
                SearchResult(
                    url=result.url,
                    title=result.title,
                    uploader=result.uploader,
                    duration=result.duration,
                    thumbnail=result.thumbnail,
                    source=result.source,
                )
                for result in track.results
            ],
        )

    # Counted from the rows, not accumulated. See the note above about resends —
    # and it also means a row the client never sends keeps the run honestly
    # short rather than letting it claim completion.
    playlist_import.matched_count = sum(
        1 for match in matches.values() if match.status != TrackMatchStatus.PENDING
    )
    if playlist_import.matched_count >= len(matches):
        playlist_import.status = PlaylistImportStatus.REVIEW

    db.commit()
    db.refresh(playlist_import)
    publish_import(playlist_import)
    return playlist_import


def _require_review(playlist_import: PlaylistImport) -> None:
    if playlist_import.status != PlaylistImportStatus.REVIEW:
        raise HTTPException(
            status_code=409, detail="Matches can only be edited while the import is in review"
        )


#: Statuses in which a single match may still be pointed somewhere else.
#:
#: `REVIEW` is the obvious one. `DONE` and `FAILED` are here because #399 built
#: the affordance for exactly that moment — a track the device could not fetch,
#: repointed by hand and then retried — and this endpoint refused it with a 409
#: reading "Matches can only be edited while the import is in review". I hit
#: it on 2026-08-09 with two tracks that had 403'd, which is precisely the case
#: the feature was written for.
#:
#: `IMPORTING` is deliberately **not** here: the download loop is walking these
#: rows, and changing the URL under a run in flight would mean a track fetched
#: from one source and recorded as another.
_EDITABLE_STATUSES = frozenset(
    {PlaylistImportStatus.REVIEW, PlaylistImportStatus.DONE, PlaylistImportStatus.FAILED}
)


def _require_editable(playlist_import: PlaylistImport) -> None:
    """A single match may be repointed during review and after the run is over.

    Separate from `_require_review` on purpose. Bulk accept/reject is a *review*
    action and stays review-only: applying it to a finished import would flip
    rows the run has already acted on, with nothing to reconcile them against.
    """
    if playlist_import.status not in _EDITABLE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail="Matches cannot be edited while the import is running",
        )


def _apply_review_action(match: TrackMatch, status: Literal["accepted", "rejected"]) -> None:
    """Set a match's review status. Callers ensure an 'accepted' match has a
    chosen_url — the single endpoint 400s without one, the bulk one skips it."""
    match.status = TrackMatchStatus.ACCEPTED if status == "accepted" else TrackMatchStatus.REJECTED


@router.patch("/{import_id}/matches/{match_id}", response_model=TrackMatchRead)
def update_track_match(
    import_id: int,
    match_id: int,
    payload: TrackMatchUpdate,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> TrackMatch:
    playlist_import = _get_import_or_404(db, import_id, owner_install_id)
    _require_editable(playlist_import)
    match = db.get(TrackMatch, match_id)
    if match is None or match.playlist_import_id != import_id:
        raise HTTPException(status_code=404, detail="Track match not found")

    if payload.chosen_url is not None:
        match.chosen_url = payload.chosen_url
        # Keep the badge honest: a picked candidate carries its own score, a
        # hand-pasted URL has no machine confidence at all.
        candidate = next((c for c in match.candidates if c.get("url") == payload.chosen_url), None)
        match.confidence = candidate["score"] if candidate else None

    if payload.status == "accepted" and match.chosen_url is None:
        raise HTTPException(status_code=400, detail="Accepting a match requires a chosen URL")
    if payload.status is not None:
        _apply_review_action(match, payload.status)

    db.commit()
    db.refresh(match)
    return match


@router.patch("/{import_id}/matches", response_model=list[TrackMatchRead])
def bulk_update_track_matches(
    import_id: int,
    payload: TrackMatchBulkUpdate,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> list[TrackMatch]:
    """Accept or reject many matches in one transaction. Accepting a match with
    no chosen URL is skipped rather than failing the batch — partial success is
    success, and the skipped rows stay visible on refetch."""
    playlist_import = _get_import_or_404(db, import_id, owner_install_id)
    _require_review(playlist_import)

    matches = db.scalars(
        select(TrackMatch).where(
            TrackMatch.playlist_import_id == import_id,
            TrackMatch.id.in_(payload.match_ids),
        )
    ).all()

    updated: list[TrackMatch] = []
    for match in matches:
        if payload.status == "accepted" and match.chosen_url is None:
            continue
        _apply_review_action(match, payload.status)
        updated.append(match)

    db.commit()
    for match in updated:
        db.refresh(match)
    return updated


@router.post("/{import_id}/confirm", response_model=PlaylistImportRead, status_code=202)
def confirm_playlist_import(
    import_id: int,
    payload: ConfirmImportRequest | None = None,
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
    owner_install_id: int | None = Depends(current_owner),
) -> PlaylistImport:
    """Accept the reviewed matches, and optionally download them here.

    Needs no Spotify configuration on purpose: from `review` on, everything runs
    against YouTube — a reviewed import can be confirmed even after the owner's
    Premium lapses.

    ## `download: false` (#268)

    Confirming used to mean two things at once: *the user accepted these
    matches*, and *server, go and fetch them*. The second is what YouTube
    refuses from a datacenter address — measured at 1 success in 14 (#177) — so
    the mobile client fetches on the device instead, where the request comes
    from a residential connection.

    The first still has to happen, or the import sits at `review` forever and
    "did I confirm this?" has no answer.

    So the two separate. With `download: false` the matches are accepted and
    **nothing is enqueued**: the server's part is finished the moment it says
    so, which is why the status goes straight to `done`. `imported_count` stays
    0 because *this server* imported nothing — the count that matters then lives
    on the device, which is the only thing that knows.

    ⚠️ **Transitional.** The end state is that the server never fetches audio
    for anyone (#246), at which point the flag goes and this endpoint only ever
    means "accepted". It exists because the web client has no device to fetch
    with yet, and breaking web import to reach the end state sooner buys
    nothing.
    """
    playlist_import = _get_import_or_404(db, import_id, owner_install_id)
    if playlist_import.status != PlaylistImportStatus.REVIEW:
        raise HTTPException(status_code=409, detail="Only an import in review can be confirmed")

    importable = (
        db.scalar(
            select(func.count())
            .select_from(TrackMatch)
            .where(
                TrackMatch.playlist_import_id == import_id,
                TrackMatch.status.in_(IMPORTABLE_STATUSES),
            )
        )
        or 0
    )
    if importable == 0:
        raise HTTPException(status_code=409, detail="No accepted matches to import")

    # Flip the status synchronously so a double-click hits the 409 guard
    # above instead of scheduling a second download run.
    download = payload.download if payload else True
    playlist_import.status = (
        PlaylistImportStatus.IMPORTING if download else PlaylistImportStatus.DONE
    )
    playlist_import.import_total = importable
    db.commit()
    db.refresh(playlist_import)
    if download:
        confirmed_import_task.delay(playlist_import.id)
    return playlist_import


@router.delete("/{import_id}", status_code=204)
def delete_playlist_import(
    import_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> None:
    """Forget an import and its matches. The songs it produced, and the
    playlist holding them, are deliberately left alone — this removes the
    record of the import, not your music."""
    playlist_import = _get_import_or_404(db, import_id, owner_install_id)
    if playlist_import.status in RUNNING_STATUSES:
        raise HTTPException(
            status_code=409,
            detail="This import is still running — wait for it to finish before deleting it",
        )
    db.delete(playlist_import)  # cascades to its TrackMatch rows
    db.commit()


def _start_retry(playlist_import: PlaylistImport, match_ids: list[int], db: Session) -> None:
    """Shared guard + hand-off for the two retry endpoints."""
    if playlist_import.status in RUNNING_STATUSES:
        raise HTTPException(status_code=409, detail="This import is still running")
    if playlist_import.playlist_id is None:
        raise HTTPException(status_code=409, detail="This import hasn't been confirmed yet")
    if not match_ids:
        raise HTTPException(status_code=409, detail="No failed tracks to retry")

    # Flip synchronously so a second click hits the guard above rather than
    # starting a competing run.
    playlist_import.status = PlaylistImportStatus.IMPORTING
    db.commit()
    db.refresh(playlist_import)
    retry_failed_matches_task.delay(playlist_import.id, match_ids)


@router.post("/{import_id}/retry-failed", response_model=PlaylistImportRead, status_code=202)
def retry_failed_matches(
    import_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
    owner_install_id: int | None = Depends(current_owner),
) -> PlaylistImport:
    """Have another go at every failed track. Most download failures are
    transient throttling, so this is usually all it takes."""
    playlist_import = _get_import_or_404(db, import_id, owner_install_id)
    match_ids = list(
        db.scalars(
            select(TrackMatch.id).where(
                TrackMatch.playlist_import_id == import_id,
                TrackMatch.status == TrackMatchStatus.FAILED,
            )
        ).all()
    )
    _start_retry(playlist_import, match_ids, db)
    return playlist_import


@router.post(
    "/{import_id}/matches/{match_id}/retry", response_model=PlaylistImportRead, status_code=202
)
def retry_one_match(
    import_id: int,
    match_id: int,
    db: Session = Depends(get_db),
    _: None = Depends(require_unlock_key),
    owner_install_id: int | None = Depends(current_owner),
) -> PlaylistImport:
    playlist_import = _get_import_or_404(db, import_id, owner_install_id)
    match = db.get(TrackMatch, match_id)
    if match is None or match.playlist_import_id != import_id:
        raise HTTPException(status_code=404, detail="Track match not found")
    if match.status != TrackMatchStatus.FAILED:
        raise HTTPException(status_code=409, detail="Only a failed track can be retried")

    _start_retry(playlist_import, [match.id], db)
    return playlist_import


def _read_import_payload(import_id: int, install: str | None) -> dict | None:
    """Fetch an import's current state as JSON, scoped to the caller's install.

    Own short-lived session — a WebSocket outlives the request-scoped one from
    `Depends(get_db)`.

    ⚠️ **Scoped since #514.** Like the jobs socket, this read an import by id
    alone while the REST routes beside it scoped by `owned_by`, so sequential
    ids could be enumerated by anyone who could reach the server.
    """
    db = SessionLocal()
    try:
        owner_install_id = resolve_install_id(db, install, create=False)
        imp = db.scalar(
            select(PlaylistImport).where(
                PlaylistImport.id == import_id,
                owned_by(PlaylistImport, owner_install_id),
            )
        )
        return PlaylistImportRead.model_validate(imp).model_dump(mode="json") if imp else None
    finally:
        db.close()


@router.websocket("/{import_id}/ws")
async def playlist_import_progress(
    websocket: WebSocket, import_id: int, install: str | None = None
) -> None:
    """Stream an import's state until it finishes — a clone of the jobs
    socket, on the playlist-import broker.

    ⚠️ The install id is a **query parameter**: browsers cannot set headers on
    a WebSocket handshake, so `X-Install-Id` is unavailable here (#514).
    """
    await websocket.accept()

    # Subscribe *before* reading current state; same lost-update reasoning as
    # the jobs socket. The worst case is a harmless duplicate frame.
    queue = playlist_import_events.subscribe(import_id)
    try:
        payload = _read_import_payload(import_id, install)
        if payload is None:
            await websocket.close(
                code=WS_CLOSE_IMPORT_NOT_FOUND, reason="Playlist import not found"
            )
            return

        await websocket.send_json(payload)
        if payload["status"] in TERMINAL_STATUSES:
            await websocket.close()
            return

        while True:
            payload = await queue.get()
            await websocket.send_json(payload)
            if payload["status"] in TERMINAL_STATUSES:
                await websocket.close()
                return
    except WebSocketDisconnect:
        pass  # Client went away; nothing to clean up beyond unsubscribing.
    finally:
        playlist_import_events.unsubscribe(import_id, queue)
