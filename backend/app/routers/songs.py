from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.db import get_db
from app.installs import current_owner, owned_by, require_install
from app.models import ImportJob, Song
from app.schemas import Page, SongRead, SongSortField, SongUpdate, SortOrder
from app.tagging import image_mime_type

router = APIRouter(prefix="/songs", tags=["songs"])

_SORT_COLUMNS = {
    SongSortField.ADDED_AT: Song.added_at,
    SongSortField.TITLE: Song.title,
    SongSortField.ARTIST: Song.artist,
    SongSortField.DURATION: Song.duration,
}


def _get_song_or_404(song_id: int, db: Session, owner_install_id: int | None) -> Song:
    """Fetch a song the caller owns. Someone else's song answers **404**, not
    403: a 403 would confirm the row exists, which is itself a leak."""
    song = db.scalar(select(Song).where(Song.id == song_id, owned_by(Song, owner_install_id)))
    if song is None:
        raise HTTPException(status_code=404, detail="Song not found")
    return song


@router.get("", response_model=Page[SongRead])
def list_songs(
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
    q: str | None = Query(default=None, description="Search title, artist and album"),
    sort: SongSortField = SongSortField.ADDED_AT,
    order: SortOrder = SortOrder.DESC,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> Page[SongRead]:
    filters = [owned_by(Song, owner_install_id)]
    if q:
        pattern = f"%{q}%"
        filters.append(
            or_(
                Song.title.ilike(pattern),
                Song.artist.ilike(pattern),
                Song.album.ilike(pattern),
            )
        )

    total = db.scalar(select(func.count()).select_from(Song).where(*filters)) or 0

    column = _SORT_COLUMNS[sort]
    ordering = column.asc() if order is SortOrder.ASC else column.desc()
    # Tie-break on id so pages stay stable when sort values are equal.
    rows = db.scalars(
        select(Song).where(*filters).order_by(ordering, Song.id.desc()).limit(limit).offset(offset)
    ).all()

    return Page[SongRead](
        items=[SongRead.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{song_id}", response_model=SongRead)
def get_song(
    song_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> Song:
    return _get_song_or_404(song_id, db, owner_install_id)


@router.patch("/{song_id}", response_model=SongRead)
def update_song(
    song_id: int,
    payload: SongUpdate,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> Song:
    """Update editable metadata on the DB record.

    Note: this does not rewrite the tags embedded in the .opus file itself, so
    the file and the DB can drift after an edit. Deliberate for now — keeping
    PATCH a pure DB operation means it can't fail on a missing or locked file.
    """
    song = _get_song_or_404(song_id, db, owner_install_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(song, field, value)
    db.commit()
    db.refresh(song)
    return song


@router.delete("/{song_id}", status_code=204)
def delete_song(
    song_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> None:
    """Remove the song, its playlist entries, and its files on disk."""
    song = _get_song_or_404(song_id, db, owner_install_id)

    # An ImportJob points at the song it produced; keep the job's history but
    # drop the now-dangling reference rather than deleting the job outright.
    db.query(ImportJob).filter(ImportJob.song_id == song.id).update({ImportJob.song_id: None})

    paths = [song.file_path, song.cover_path]
    # Playlist entries go with it via the ORM cascade on Song.playlist_items.
    db.delete(song)
    db.commit()

    for raw_path in paths:
        if raw_path:
            Path(raw_path).unlink(missing_ok=True)


@router.post("/{song_id}/confirm-receipt", status_code=204)
def confirm_song_receipt(
    song_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int = Depends(require_install),
) -> None:
    """A device says it holds this audio; delete the server's copy (#221).

    The end of #159. Server storage grows with every user, and once the audio is
    on the device the server's copy is nothing but a cache — see ADR-017 for the
    decision and what it costs.

    ## Why this is a call the client makes, and not "the job is done"

    The handover's failure path deliberately leaves the song unmarked so the
    next launch tries again, **and that retry reads the server's copy**. So
    deleting when the job finishes would race the very mechanism that recovers a
    failed handover: the job is `done` the moment the server has the file, which
    is before any device has it. Only the device knows the bytes landed, so only
    the device can say so.

    ## Idempotent, and deliberately quiet

    A client that confirms twice — a retry, a duplicate tap, an app restarted
    mid-request — gets the same 204. Answering 409 the second time would make a
    successful outcome look like a failure and invite the client to "fix" it.

    The row stays. It is what the library is; only the bytes go.
    """
    song = _get_song_or_404(song_id, db, owner_install_id)

    if song.audio_released_at is None:
        song.audio_released_at = datetime.now(UTC)
        db.commit()

    # Outside the `if`, so a confirmation that crashed between the commit and
    # the unlink is repaired by the next one rather than leaving a file nobody
    # will ever read. `missing_ok` because the ordinary case here is that it is
    # already gone.
    Path(song.file_path).unlink(missing_ok=True)


@router.get("/{song_id}/audio")
def get_song_audio(
    song_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> FileResponse:
    """Stream the audio file.

    Returned via FileResponse, which handles HTTP Range requests (206 Partial
    Content) — that is what lets a browser's <audio> element seek.
    """
    song = _get_song_or_404(song_id, db, owner_install_id)
    # 410, not 404, and the distinction is worth a status code: the audio was
    # here and was deliberately released to a device that confirmed it (#221).
    # A 404 saying "missing from storage" would report an intended state as a
    # fault, and send whoever reads it looking for a bug.
    if song.audio_released_at is not None:
        raise HTTPException(
            status_code=410,
            detail="This audio now lives on the device that downloaded it",
        )
    path = Path(song.file_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Audio file is missing from storage")
    return FileResponse(path, media_type="audio/ogg", filename=f"{song.title}.opus")


@router.get("/{song_id}/cover")
def get_song_cover(
    song_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> FileResponse:
    song = _get_song_or_404(song_id, db, owner_install_id)
    if not song.cover_path:
        raise HTTPException(status_code=404, detail="Song has no cover art")
    path = Path(song.cover_path)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Cover file is missing from storage")
    return FileResponse(path, media_type=image_mime_type(path))
