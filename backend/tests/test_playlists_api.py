from collections.abc import Callable

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Playlist, PlaylistItem, Song


def _create_playlist(client: TestClient, name: str = "Road Trip") -> int:
    response = client.post("/playlists", json={"name": name})
    assert response.status_code == 201
    return response.json()["id"]


def test_create_playlist(client: TestClient) -> None:
    response = client.post("/playlists", json={"name": "Focus"})

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Focus"
    assert body["item_count"] == 0


def test_create_playlist_rejects_empty_name(client: TestClient) -> None:
    assert client.post("/playlists", json={"name": ""}).status_code == 422


def test_list_playlists_reports_item_counts(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    playlist_id = _create_playlist(client)
    _create_playlist(client, name="Empty One")
    song = make_song()
    client.post(f"/playlists/{playlist_id}/items", json={"song_id": song.id})

    body = client.get("/playlists").json()

    assert body["total"] == 2
    counts = {item["name"]: item["item_count"] for item in body["items"]}
    assert counts == {"Road Trip": 1, "Empty One": 0}


def test_get_playlist_returns_items_in_position_order(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    playlist_id = _create_playlist(client)
    first = make_song(title="First")
    second = make_song(title="Second")
    client.post(f"/playlists/{playlist_id}/items", json={"song_id": first.id})
    client.post(f"/playlists/{playlist_id}/items", json={"song_id": second.id})

    body = client.get(f"/playlists/{playlist_id}").json()

    assert [item["position"] for item in body["items"]] == [0, 1]
    assert [item["song"]["title"] for item in body["items"]] == ["First", "Second"]


def test_get_unknown_playlist_returns_404(client: TestClient) -> None:
    assert client.get("/playlists/999999").status_code == 404


def test_rename_playlist(client: TestClient) -> None:
    playlist_id = _create_playlist(client)

    response = client.patch(f"/playlists/{playlist_id}", json={"name": "Renamed"})

    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"


def test_delete_playlist_removes_items_but_keeps_songs(
    client: TestClient, db_session: Session, make_song: Callable[..., Song]
) -> None:
    playlist_id = _create_playlist(client)
    song = make_song()
    client.post(f"/playlists/{playlist_id}/items", json={"song_id": song.id})

    response = client.delete(f"/playlists/{playlist_id}")

    assert response.status_code == 204
    assert db_session.get(Playlist, playlist_id) is None
    assert db_session.query(PlaylistItem).count() == 0
    assert db_session.get(Song, song.id) is not None


def test_add_item_appends_to_the_end(client: TestClient, make_song: Callable[..., Song]) -> None:
    playlist_id = _create_playlist(client)
    first = make_song(title="First")
    second = make_song(title="Second")

    client.post(f"/playlists/{playlist_id}/items", json={"song_id": first.id})
    body = client.post(f"/playlists/{playlist_id}/items", json={"song_id": second.id}).json()

    assert [item["song"]["title"] for item in body["items"]] == ["First", "Second"]


def test_add_item_404s_for_unknown_song(client: TestClient) -> None:
    playlist_id = _create_playlist(client)

    response = client.post(f"/playlists/{playlist_id}/items", json={"song_id": 999999})

    assert response.status_code == 404


def test_remove_item_renumbers_remaining_positions(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    playlist_id = _create_playlist(client)
    songs = [make_song(title=f"Song {i}") for i in range(3)]
    for song in songs:
        client.post(f"/playlists/{playlist_id}/items", json={"song_id": song.id})
    items = client.get(f"/playlists/{playlist_id}").json()["items"]

    response = client.delete(f"/playlists/{playlist_id}/items/{items[0]['id']}")

    assert response.status_code == 204
    remaining = client.get(f"/playlists/{playlist_id}").json()["items"]
    assert [item["position"] for item in remaining] == [0, 1]
    assert [item["song"]["title"] for item in remaining] == ["Song 1", "Song 2"]


def test_remove_item_404s_when_item_belongs_to_another_playlist(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    owner_id = _create_playlist(client, name="Owner")
    other_id = _create_playlist(client, name="Other")
    song = make_song()
    client.post(f"/playlists/{owner_id}/items", json={"song_id": song.id})
    item_id = client.get(f"/playlists/{owner_id}").json()["items"][0]["id"]

    assert client.delete(f"/playlists/{other_id}/items/{item_id}").status_code == 404


def test_reorder_items(client: TestClient, make_song: Callable[..., Song]) -> None:
    playlist_id = _create_playlist(client)
    for index in range(3):
        client.post(
            f"/playlists/{playlist_id}/items",
            json={"song_id": make_song(title=f"Song {index}").id},
        )
    items = client.get(f"/playlists/{playlist_id}").json()["items"]
    reversed_ids = [item["id"] for item in reversed(items)]

    response = client.put(f"/playlists/{playlist_id}/items", json={"item_ids": reversed_ids})

    assert response.status_code == 200
    assert [item["song"]["title"] for item in response.json()["items"]] == [
        "Song 2",
        "Song 1",
        "Song 0",
    ]


def test_reorder_rejects_an_incomplete_id_list(
    client: TestClient, make_song: Callable[..., Song]
) -> None:
    playlist_id = _create_playlist(client)
    for index in range(2):
        client.post(
            f"/playlists/{playlist_id}/items",
            json={"song_id": make_song(title=f"Song {index}").id},
        )
    items = client.get(f"/playlists/{playlist_id}").json()["items"]

    response = client.put(f"/playlists/{playlist_id}/items", json={"item_ids": [items[0]["id"]]})

    assert response.status_code == 400
