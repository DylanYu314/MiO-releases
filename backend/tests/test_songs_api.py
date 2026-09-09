from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import ImportJob, ImportStatus, Playlist, PlaylistItem, Song


def test_list_songs_is_paginated(client: TestClient, make_song: Callable[..., Song]) -> None:
    for index in range(3):
        make_song(title=f"Song {index}")

    response = client.get("/songs", params={"limit": 2, "offset": 0})

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 3
    assert body["limit"] == 2
    assert body["offset"] == 0
    assert len(body["items"]) == 2


def test_list_songs_searches_title_artist_and_album(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    make_song(title="Bohemian Rhapsody", artist="Queen", album="A Night at the Opera")
    make_song(title="Something Else", artist="Another Artist", album="Other")

    by_title = client.get("/songs", params={"q": "bohemian"}).json()
    by_artist = client.get("/songs", params={"q": "queen"}).json()
    by_album = client.get("/songs", params={"q": "night at the opera"}).json()

    for result in (by_title, by_artist, by_album):
        assert result["total"] == 1
        assert result["items"][0]["title"] == "Bohemian Rhapsody"


def test_list_songs_sorts_by_requested_field(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    make_song(title="Charlie")
    make_song(title="Alpha")
    make_song(title="Bravo")

    titles = [
        item["title"]
        for item in client.get("/songs", params={"sort": "title", "order": "asc"}).json()["items"]
    ]

    assert titles == ["Alpha", "Bravo", "Charlie"]


def test_list_songs_rejects_unknown_sort_field(client: TestClient) -> None:
    assert client.get("/songs", params={"sort": "not_a_column"}).status_code == 422


def test_get_song(client: TestClient, make_song: Callable[..., Song]) -> None:
    song = make_song(title="Findable")

    response = client.get(f"/songs/{song.id}")

    assert response.status_code == 200
    assert response.json()["title"] == "Findable"


def test_get_unknown_song_returns_404(client: TestClient) -> None:
    assert client.get("/songs/999999").status_code == 404


def test_update_song_only_changes_supplied_fields(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song(title="Old Title", artist="Original Artist")

    response = client.patch(f"/songs/{song.id}", json={"title": "New Title"})

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "New Title"
    assert body["artist"] == "Original Artist"


def test_update_song_rejects_empty_title(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()

    assert client.patch(f"/songs/{song.id}", json={"title": ""}).status_code == 422


def test_delete_song_removes_row_files_and_playlist_entries(
    client: TestClient, db_session: Session, make_song: Callable[..., Song]
) -> None:
    song = make_song()
    audio_path = Path(song.file_path)
    cover_path = Path(song.cover_path)

    playlist = Playlist(name="Mix")
    db_session.add(playlist)
    db_session.commit()
    db_session.add(PlaylistItem(playlist_id=playlist.id, song_id=song.id, position=0))
    db_session.commit()

    response = client.delete(f"/songs/{song.id}")

    assert response.status_code == 204
    db_session.expunge_all()  # this session cached the row the request just deleted
    assert db_session.get(Song, song.id) is None
    assert db_session.query(PlaylistItem).count() == 0
    assert not audio_path.exists()
    assert not cover_path.exists()


def test_delete_song_keeps_import_job_but_clears_its_reference(
    client: TestClient, db_session: Session, make_song: Callable[..., Song]
) -> None:
    song = make_song()
    job = ImportJob(source_url=song.source_url, status=ImportStatus.DONE, song_id=song.id)
    db_session.add(job)
    db_session.commit()

    client.delete(f"/songs/{song.id}")

    db_session.expire_all()
    reloaded = db_session.get(ImportJob, job.id)
    assert reloaded is not None
    assert reloaded.song_id is None


def test_delete_unknown_song_returns_404(client: TestClient) -> None:
    assert client.delete("/songs/999999").status_code == 404


def test_get_song_audio_streams_the_file(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()

    response = client.get(f"/songs/{song.id}/audio")

    assert response.status_code == 200
    assert response.content == b"fake-opus-bytes"


def test_get_song_audio_supports_range_requests_for_seeking(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()

    response = client.get(f"/songs/{song.id}/audio", headers={"Range": "bytes=0-3"})

    assert response.status_code == 206
    assert response.content == b"fake"
    assert response.headers["content-range"] == "bytes 0-3/15"


def test_get_song_audio_404s_when_file_is_missing(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()
    Path(song.file_path).unlink()

    assert client.get(f"/songs/{song.id}/audio").status_code == 404


def test_get_song_cover(client: TestClient, make_song: Callable[..., Song]) -> None:
    song = make_song()

    response = client.get(f"/songs/{song.id}/cover")

    assert response.status_code == 200
    assert response.content == b"fake-cover-bytes"


def test_get_song_cover_404s_when_song_has_none(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song(with_files=False)

    assert client.get(f"/songs/{song.id}/cover").status_code == 404


def test_get_song_cover_sets_webp_content_type(
    client: TestClient, db_session: Session, make_song: Callable[..., Song], library_path: Path
) -> None:
    """yt-dlp saves thumbnails as .webp, which stdlib mimetypes doesn't recognise."""
    song = make_song()
    webp_path = library_path / "cover.webp"
    webp_path.write_bytes(b"fake-webp-bytes")
    song.cover_path = str(webp_path)
    db_session.commit()

    response = client.get(f"/songs/{song.id}/cover")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"


# ---------------------------------------------------------------------------
# Releasing the audio once a device has it (#221, ADR-017)
# ---------------------------------------------------------------------------


def _released_at(db_session: Session, song_id: int):
    db_session.expire_all()
    row = db_session.get(Song, song_id)
    assert row is not None
    return row.audio_released_at


def test_confirming_receipt_deletes_the_file_and_keeps_the_row(
    client: TestClient, make_song: Callable[..., Song], db_session: Session
) -> None:
    """The point of #221: the row is the library, only the bytes go."""
    song = make_song()
    audio = Path(song.file_path)
    assert audio.exists()

    response = client.post(f"/songs/{song.id}/confirm-receipt")

    assert response.status_code == 204
    assert not audio.exists()
    # Still there, and still readable — deleting the row would take the
    # playlist entries and the import history with it.
    assert client.get(f"/songs/{song.id}").status_code == 200
    assert _released_at(db_session, song.id) is not None


def test_released_audio_answers_410_not_404(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    # The audio was here and was deliberately given up. Reporting that as
    # "missing from storage" sends whoever reads it looking for a bug.
    song = make_song()
    client.post(f"/songs/{song.id}/confirm-receipt")

    response = client.get(f"/songs/{song.id}/audio")

    assert response.status_code == 410
    assert "device" in response.json()["detail"]


def test_a_file_that_is_merely_missing_is_still_404(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    # The distinction the column exists for: nobody released this, the file is
    # simply not where the row says it is, and that is a fault.
    song = make_song(with_files=False)

    response = client.get(f"/songs/{song.id}/audio")

    assert response.status_code == 404


def test_confirming_twice_is_not_an_error(
    client: TestClient, make_song: Callable[..., Song], db_session: Session
) -> None:
    # A retry, a duplicate tap, an app restarted mid-request. Answering 409 the
    # second time makes a successful outcome look like a failure.
    song = make_song()

    first = client.post(f"/songs/{song.id}/confirm-receipt")
    released_at = _released_at(db_session, song.id)
    second = client.post(f"/songs/{song.id}/confirm-receipt")

    assert (first.status_code, second.status_code) == (204, 204)
    # And the moment recorded is the *first* confirmation, not the latest one.
    assert _released_at(db_session, song.id) == released_at


def test_confirming_clears_a_file_left_by_a_half_done_confirmation(
    client: TestClient, make_song: Callable[..., Song], db_session: Session
) -> None:
    """The unlink sits outside the `if`, deliberately.

    A confirmation that committed and then died before deleting would otherwise
    leave a file nobody will ever read: the row says released, so nothing serves
    it, and a second confirmation that skipped the unlink would never reclaim it.
    """
    song = make_song()
    audio = Path(song.file_path)
    song.audio_released_at = datetime.now(UTC)
    db_session.commit()

    client.post(f"/songs/{song.id}/confirm-receipt")

    assert not audio.exists()


def test_deleting_a_released_song_does_not_trip_on_the_missing_file(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()
    client.post(f"/songs/{song.id}/confirm-receipt")

    assert client.delete(f"/songs/{song.id}").status_code == 204
