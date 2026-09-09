from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import Playlist, PlaylistKind, Song


def test_favourites_is_created_on_first_read(client: TestClient, db_session: Session) -> None:
    # An untouched library shouldn't already contain a playlist nobody made.
    assert db_session.scalars(select(Playlist)).all() == []

    body = client.get("/playlists/favourites").json()

    assert body["kind"] == "favourites"
    assert body["items"] == []
    assert len(db_session.scalars(select(Playlist)).all()) == 1


def test_song_ids_are_empty_before_anything_is_hearted(client: TestClient) -> None:
    # Notably without creating the playlist — a list view asking for hearts
    # must not conjure one as a side effect.
    assert client.get("/playlists/favourites/song-ids").json() == {"song_ids": []}


def test_heart_and_unheart_a_song(
    client: TestClient, make_song: Callable[..., Song], db_session: Session
) -> None:
    song = make_song()

    added = client.post("/playlists/favourites/items", json={"song_id": song.id})
    assert added.status_code == 201
    assert [item["song"]["id"] for item in added.json()["items"]] == [song.id]
    assert client.get("/playlists/favourites/song-ids").json() == {"song_ids": [song.id]}

    removed = client.delete(f"/playlists/favourites/items/{song.id}")
    assert removed.status_code == 204
    assert client.get("/playlists/favourites/song-ids").json() == {"song_ids": []}
    # The song itself survives being un-hearted.
    assert db_session.get(Song, song.id) is not None


def test_hearting_twice_does_not_duplicate(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()

    client.post("/playlists/favourites/items", json={"song_id": song.id})
    client.post("/playlists/favourites/items", json={"song_id": song.id})

    assert client.get("/playlists/favourites/song-ids").json() == {"song_ids": [song.id]}


def test_unhearting_something_that_was_never_hearted_is_fine(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()

    # No favourites playlist exists yet at all.
    assert client.delete(f"/playlists/favourites/items/{song.id}").status_code == 204


def test_hearting_an_unknown_song_is_404(client: TestClient) -> None:
    assert client.post("/playlists/favourites/items", json={"song_id": 999}).status_code == 404


def test_favourites_cannot_be_renamed_or_deleted(client: TestClient) -> None:
    favourites_id = client.get("/playlists/favourites").json()["id"]

    assert client.patch(f"/playlists/{favourites_id}", json={"name": "Nope"}).status_code == 409
    assert client.delete(f"/playlists/{favourites_id}").status_code == 409
    # ...and it's still there.
    assert client.get(f"/playlists/{favourites_id}").status_code == 200


def test_ordinary_playlists_are_still_renameable(client: TestClient) -> None:
    playlist_id = client.post("/playlists", json={"name": "Road Trip"}).json()["id"]

    assert client.patch(f"/playlists/{playlist_id}", json={"name": "Renamed"}).status_code == 200
    assert client.delete(f"/playlists/{playlist_id}").status_code == 204


def test_favourites_reports_its_kind_in_the_list(client: TestClient) -> None:
    client.post("/playlists", json={"name": "Road Trip"})
    client.get("/playlists/favourites")

    kinds = {item["name"]: item["kind"] for item in client.get("/playlists").json()["items"]}

    assert kinds == {"Road Trip": "user", "Favourites": "favourites"}


def test_positions_stay_dense_after_unhearting(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    songs = [make_song(title=f"Song {index}") for index in range(3)]
    for song in songs:
        client.post("/playlists/favourites/items", json={"song_id": song.id})

    client.delete(f"/playlists/favourites/items/{songs[0].id}")

    items = client.get("/playlists/favourites").json()["items"]
    assert [item["position"] for item in items] == [0, 1]
    assert [item["song"]["id"] for item in items] == [songs[1].id, songs[2].id]


def test_deleting_a_song_removes_it_from_favourites(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    song = make_song()
    client.post("/playlists/favourites/items", json={"song_id": song.id})

    client.delete(f"/songs/{song.id}")

    assert client.get("/playlists/favourites/song-ids").json() == {"song_ids": []}


def test_favourites_kind_defaults_to_user_for_new_playlists(
    client: TestClient, db_session: Session
) -> None:
    playlist_id = client.post("/playlists", json={"name": "Road Trip"}).json()["id"]

    playlist = db_session.get(Playlist, playlist_id)
    assert playlist is not None
    assert playlist.kind == PlaylistKind.USER


def test_playlists_created_before_the_kind_column_still_load(
    client: TestClient, db_session: Session
) -> None:
    """A row whose `kind` was written outside the ORM must still be readable.

    The migration that added this column back-filled the enum's *value*
    ("user") where SQLAlchemy reads its *name* ("USER"), which made every
    pre-existing playlist 500 on load. Nothing in the mocked suite noticed,
    because tests only ever create rows through the ORM — this one writes the
    raw value the way a migration does.
    """
    playlist_id = client.post("/playlists", json={"name": "Older Playlist"}).json()["id"]
    db_session.execute(
        text("UPDATE playlists SET kind = 'USER' WHERE id = :id"), {"id": playlist_id}
    )
    db_session.commit()

    listed = client.get("/playlists")
    assert listed.status_code == 200
    assert client.get(f"/playlists/{playlist_id}").status_code == 200
