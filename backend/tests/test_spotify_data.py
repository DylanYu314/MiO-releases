import httpx
import pytest

import app.spotify as spotify
from app.spotify import fetch_all_playlist_tracks, fetch_all_saved_tracks, list_playlists


@pytest.fixture
def transport(monkeypatch: pytest.MonkeyPatch):
    def install(handler) -> None:
        monkeypatch.setattr(spotify, "_transport", httpx.MockTransport(handler))

    return install


def playlist_obj(**overrides: object) -> dict:
    base = {
        "id": "pl-1",
        "name": "Road Trip",
        "images": [{"url": "https://img/1"}],
        "items": {"total": 12},
        "owner": {"display_name": "Alex"},
    }
    base.update(overrides)
    return base


def track_obj(name: str = "Song 1", **overrides: object) -> dict:
    base = {
        "id": "t1",
        "type": "track",
        "name": name,
        "artists": [{"name": "Artist A"}, {"name": "Artist B"}],
        "album": {"name": "Album"},
        "duration_ms": 200500,
    }
    base.update(overrides)
    return base


def test_list_playlists_parses_a_page(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/me/playlists"
        assert request.url.params["limit"] == "50"
        assert request.url.params["offset"] == "0"
        return httpx.Response(200, json={"items": [playlist_obj(), None], "total": 42})

    transport(handler)
    playlists, total = list_playlists("tok")

    assert total == 42
    assert len(playlists) == 1
    assert playlists[0].name == "Road Trip"
    assert playlists[0].image_url == "https://img/1"
    assert playlists[0].track_count == 12
    assert playlists[0].owner_name == "Alex"


def test_list_playlists_accepts_the_deprecated_tracks_field(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        obj = playlist_obj(images=[], tracks={"total": 5})
        del obj["items"]
        return httpx.Response(200, json={"items": [obj], "total": 1})

    transport(handler)
    playlists, _ = list_playlists("tok")

    assert playlists[0].track_count == 5
    assert playlists[0].image_url is None


def test_fetch_playlist_tracks_pages_and_skips_gaps(transport) -> None:
    offsets: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/playlists/pl-1/items"
        offsets.append(request.url.params["offset"])
        if request.url.params["offset"] == "0":
            return httpx.Response(
                200,
                json={
                    "items": [{"item": track_obj()}, {"item": None}],
                    "next": "https://api.spotify.com/v1/next-page",
                },
            )
        return httpx.Response(
            200,
            json={
                "items": [
                    # Podcast episodes in a playlist aren't importable songs.
                    {"item": track_obj(name="Episode", type="episode")},
                    # Pre-migration responses used `track` — still accepted.
                    {"track": track_obj(name="Legacy Song", id="t2")},
                ],
                "next": None,
            },
        )

    transport(handler)
    tracks = fetch_all_playlist_tracks("tok", "pl-1")

    assert offsets == ["0", "2"]
    assert [track.title for track in tracks] == ["Song 1", "Legacy Song"]
    assert tracks[0].artist == "Artist A, Artist B"
    assert tracks[0].album == "Album"
    assert tracks[0].duration_s == 200.5


def test_fetch_saved_tracks_reads_the_track_field(transport) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/me/tracks"
        return httpx.Response(200, json={"items": [{"track": track_obj()}], "next": None})

    transport(handler)
    tracks = fetch_all_saved_tracks("tok")

    assert len(tracks) == 1
    assert tracks[0].external_id == "t1"
