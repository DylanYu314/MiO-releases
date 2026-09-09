from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.db import get_db
from app.installs import current_owner, owned_by, require_install
from app.models import Playlist, PlaylistItem, PlaylistKind, Song
from app.schemas import (
    FavouriteSongIds,
    Page,
    PlaylistCreate,
    PlaylistDetail,
    PlaylistItemCreate,
    PlaylistRead,
    PlaylistReorder,
    PlaylistUpdate,
)

FAVOURITES_NAME = "Favourites"

router = APIRouter(prefix="/playlists", tags=["playlists"])


def _get_playlist_or_404(playlist_id: int, db: Session, owner_install_id: int | None) -> Playlist:
    """Someone else's playlist answers 404, not 403 — a 403 confirms it exists."""
    playlist = db.scalar(
        select(Playlist).where(Playlist.id == playlist_id, owned_by(Playlist, owner_install_id))
    )
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


def _load_detail(playlist_id: int, db: Session, owner_install_id: int | None) -> Playlist:
    """Load a playlist with its items and their songs in one go (avoids N+1 queries)."""
    playlist = db.scalar(
        select(Playlist)
        .where(Playlist.id == playlist_id, owned_by(Playlist, owner_install_id))
        .options(selectinload(Playlist.items).selectinload(PlaylistItem.song))
    )
    if playlist is None:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist


def _get_favourites(db: Session, owner_install_id: int | None, *, create: bool) -> Playlist | None:
    """The caller's favourites playlist, created on first use.

    Created lazily rather than seeded by the migration so an untouched library
    doesn't sprout a playlist nobody asked for. There is one *per owner*, not
    one globally — two key holders each get their own hearts.
    """
    playlist = db.scalar(
        select(Playlist).where(
            Playlist.kind == PlaylistKind.FAVOURITES, owned_by(Playlist, owner_install_id)
        )
    )
    if playlist is not None or not create:
        return playlist

    playlist = Playlist(
        name=FAVOURITES_NAME, kind=PlaylistKind.FAVOURITES, owner_install_id=owner_install_id
    )
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    return playlist


def _reject_if_favourites(playlist: Playlist) -> None:
    """Favourites is managed by the heart button, not by playlist CRUD."""
    if playlist.kind == PlaylistKind.FAVOURITES:
        raise HTTPException(status_code=409, detail="The favourites playlist can't be changed")


def _renumber(playlist: Playlist, db: Session) -> None:
    """Rewrite positions as a dense 0-based sequence in current order."""
    items = db.scalars(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == playlist.id)
        .order_by(PlaylistItem.position)
    ).all()
    for index, item in enumerate(items):
        item.position = index


@router.post("", response_model=PlaylistRead, status_code=201)
def create_playlist(
    payload: PlaylistCreate,
    db: Session = Depends(get_db),
    owner_install_id: int = Depends(require_install),
) -> PlaylistRead:
    playlist = Playlist(name=payload.name, owner_install_id=owner_install_id)
    db.add(playlist)
    db.commit()
    db.refresh(playlist)
    return PlaylistRead(
        id=playlist.id,
        name=playlist.name,
        kind=playlist.kind,
        item_count=0,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
    )


@router.get("", response_model=Page[PlaylistRead])
def list_playlists(
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> Page[PlaylistRead]:
    total = (
        db.scalar(
            select(func.count()).select_from(Playlist).where(owned_by(Playlist, owner_install_id))
        )
        or 0
    )

    # Count items per playlist in one grouped subquery rather than loading every
    # item just to call len() on it.
    counts = (
        select(PlaylistItem.playlist_id, func.count().label("item_count"))
        .group_by(PlaylistItem.playlist_id)
        .subquery()
    )
    rows = db.execute(
        select(Playlist, func.coalesce(counts.c.item_count, 0))
        .outerjoin(counts, counts.c.playlist_id == Playlist.id)
        .where(owned_by(Playlist, owner_install_id))
        .order_by(Playlist.created_at.desc(), Playlist.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()

    return Page[PlaylistRead](
        items=[
            PlaylistRead(
                id=playlist.id,
                name=playlist.name,
                kind=playlist.kind,
                item_count=item_count,
                created_at=playlist.created_at,
                updated_at=playlist.updated_at,
            )
            for playlist, item_count in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/favourites", response_model=PlaylistDetail)
def get_favourites(
    db: Session = Depends(get_db),
    owner_install_id: int = Depends(require_install),
) -> Playlist:
    """The favourites playlist, created on first read so the UI always has one."""
    playlist = _get_favourites(db, owner_install_id, create=True)
    assert playlist is not None  # create=True always returns one
    return _load_detail(playlist.id, db, owner_install_id)


@router.get("/favourites/song-ids", response_model=FavouriteSongIds)
def get_favourite_song_ids(
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> FavouriteSongIds:
    """Ids only — enough to draw a heart on every row in a list view, without
    shipping the whole favourites playlist to render it."""
    playlist = _get_favourites(db, owner_install_id, create=False)
    if playlist is None:
        return FavouriteSongIds(song_ids=[])
    rows = db.scalars(
        select(PlaylistItem.song_id)
        .where(PlaylistItem.playlist_id == playlist.id)
        .order_by(PlaylistItem.position)
    ).all()
    return FavouriteSongIds(song_ids=list(rows))


@router.post("/favourites/items", response_model=PlaylistDetail, status_code=201)
def add_favourite(
    payload: PlaylistItemCreate,
    db: Session = Depends(get_db),
    owner_install_id: int = Depends(require_install),
) -> Playlist:
    """Heart a song. Idempotent — hearting twice is not an error, and does not
    add it twice (unlike ordinary playlists, where duplicates are allowed)."""
    if (
        db.scalar(select(Song).where(Song.id == payload.song_id, owned_by(Song, owner_install_id)))
        is None
    ):
        raise HTTPException(status_code=404, detail="Song not found")

    playlist = _get_favourites(db, owner_install_id, create=True)
    assert playlist is not None
    existing = db.scalar(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist.id, PlaylistItem.song_id == payload.song_id
        )
    )
    if existing is None:
        count = (
            db.scalar(
                select(func.count())
                .select_from(PlaylistItem)
                .where(PlaylistItem.playlist_id == playlist.id)
            )
            or 0
        )
        db.add(PlaylistItem(playlist_id=playlist.id, song_id=payload.song_id, position=count))
        db.commit()
    return _load_detail(playlist.id, db, owner_install_id)


@router.delete("/favourites/items/{song_id}", status_code=204)
def remove_favourite(
    song_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> None:
    """Un-heart a song. Keyed by song id, not item id — the heart is on the
    song, and the caller has no reason to know the playlist item's id."""
    playlist = _get_favourites(db, owner_install_id, create=False)
    if playlist is None:
        return

    item = db.scalar(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist.id, PlaylistItem.song_id == song_id
        )
    )
    if item is None:
        return

    db.delete(item)
    db.flush()
    _renumber(playlist, db)
    db.commit()


@router.get("/{playlist_id}", response_model=PlaylistDetail)
def get_playlist(
    playlist_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> Playlist:
    return _load_detail(playlist_id, db, owner_install_id)


@router.patch("/{playlist_id}", response_model=PlaylistRead)
def update_playlist(
    playlist_id: int,
    payload: PlaylistUpdate,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> PlaylistRead:
    playlist = _get_playlist_or_404(playlist_id, db, owner_install_id)
    _reject_if_favourites(playlist)
    playlist.name = payload.name
    db.commit()
    db.refresh(playlist)

    item_count = (
        db.scalar(
            select(func.count())
            .select_from(PlaylistItem)
            .where(PlaylistItem.playlist_id == playlist.id)
        )
        or 0
    )
    return PlaylistRead(
        id=playlist.id,
        name=playlist.name,
        kind=playlist.kind,
        item_count=item_count,
        created_at=playlist.created_at,
        updated_at=playlist.updated_at,
    )


@router.delete("/{playlist_id}", status_code=204)
def delete_playlist(
    playlist_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> None:
    """Delete the playlist. Its items go too; the songs themselves are untouched."""
    playlist = _get_playlist_or_404(playlist_id, db, owner_install_id)
    _reject_if_favourites(playlist)
    db.delete(playlist)
    db.commit()


@router.post("/{playlist_id}/items", response_model=PlaylistDetail, status_code=201)
def add_playlist_item(
    playlist_id: int,
    payload: PlaylistItemCreate,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> Playlist:
    """Append a song to the end of the playlist. The same song may appear twice."""
    playlist = _get_playlist_or_404(playlist_id, db, owner_install_id)
    # A song you do not own cannot be added, or a playlist would become a way to
    # name someone else's rows.
    if (
        db.scalar(select(Song).where(Song.id == payload.song_id, owned_by(Song, owner_install_id)))
        is None
    ):
        raise HTTPException(status_code=404, detail="Song not found")

    next_position = (
        db.scalar(
            select(func.count())
            .select_from(PlaylistItem)
            .where(PlaylistItem.playlist_id == playlist.id)
        )
        or 0
    )
    db.add(PlaylistItem(playlist_id=playlist.id, song_id=payload.song_id, position=next_position))
    db.commit()
    return _load_detail(playlist_id, db, owner_install_id)


@router.delete("/{playlist_id}/items/{item_id}", status_code=204)
def remove_playlist_item(
    playlist_id: int,
    item_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> None:
    playlist = _get_playlist_or_404(playlist_id, db, owner_install_id)
    item = db.get(PlaylistItem, item_id)
    if item is None or item.playlist_id != playlist.id:
        raise HTTPException(status_code=404, detail="Playlist item not found")

    db.delete(item)
    db.flush()
    _renumber(playlist, db)
    db.commit()


@router.put("/{playlist_id}/items", response_model=PlaylistDetail)
def reorder_playlist_items(
    playlist_id: int,
    payload: PlaylistReorder,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> Playlist:
    """Set a new order. `item_ids` must be exactly this playlist's item ids."""
    playlist = _get_playlist_or_404(playlist_id, db, owner_install_id)
    items = db.scalars(select(PlaylistItem).where(PlaylistItem.playlist_id == playlist.id)).all()

    by_id = {item.id: item for item in items}
    if sorted(payload.item_ids) != sorted(by_id):
        raise HTTPException(
            status_code=400,
            detail="item_ids must contain exactly the ids currently in this playlist",
        )

    for position, item_id in enumerate(payload.item_ids):
        by_id[item_id].position = position
    db.commit()
    return _load_detail(playlist_id, db, owner_install_id)
