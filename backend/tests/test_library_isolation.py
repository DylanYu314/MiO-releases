"""Per-install library isolation (#170).

Once someone other than the author uses a hosted instance this stops being a
tidiness feature and becomes a security boundary — and a boundary is only as
strong as the endpoint that forgets it. So every read path gets its own test
rather than trusting that they all call the same helper.

Ownership used to hang off the **access key** (P12). Two tests here exist
specifically because that was wrong, and they are the ones to read first:

- `test_two_keyless_installs_do_not_share_a_library` — under P12 every keyless
  caller's rows were owned by nobody, so they all shared one library;
- `test_adding_an_access_key_does_not_change_what_you_can_see` — under P12
  presenting a key re-scoped every read, so everything imported beforehand
  vanished and the library looked wiped.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import app.routers.jobs as jobs_router
from app.access_keys import create_access_key
from app.installs import resolve_install_id
from app.models import Install, Playlist, PlaylistImport, Song

ALICE = "alice-install-token-0123456789"
BOB = "bob-install-token-0123456789"


@pytest.fixture(autouse=True)
def _stub_enqueue(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs_router.import_job_task, "delay", lambda job_id: None)


@pytest.fixture
def two_installs() -> tuple[dict[str, str], dict[str, str]]:
    """Headers for two separate installs. Neither carries an access key: owning a
    library and being allowed to import are now different questions."""
    return {"X-Install-Id": ALICE}, {"X-Install-Id": BOB}


def _install_id(db_session: Session, headers: dict[str, str]) -> int:
    install_id = resolve_install_id(db_session, headers["X-Install-Id"], create=True)
    assert install_id is not None
    return install_id


def _song(db_session: Session, title: str, owner_install_id: int | None) -> Song:
    song = Song(
        title=title,
        artist="Artist",
        file_path=f"/library/{title}.opus",
        file_hash="hash",
        source_url=f"https://example.com/{title}",
        source_platform="youtube",
        owner_install_id=owner_install_id,
    )
    db_session.add(song)
    db_session.commit()
    db_session.refresh(song)
    return song


# --- the two failures #170 exists to fix ------------------------------------


def test_two_keyless_installs_do_not_share_a_library(
    client: TestClient, db_session: Session, two_installs
) -> None:
    """The first P12 failure. Neither caller has an access key — under the old
    model both their rows were owned by nobody, so each saw the other's music."""
    alice, bob = two_installs
    _song(db_session, "AliceSong", _install_id(db_session, alice))
    _song(db_session, "BobSong", _install_id(db_session, bob))

    alice_titles = [s["title"] for s in client.get("/songs", headers=alice).json()["items"]]
    bob_titles = [s["title"] for s in client.get("/songs", headers=bob).json()["items"]]

    assert alice_titles == ["AliceSong"]
    assert bob_titles == ["BobSong"]


def test_adding_an_access_key_does_not_change_what_you_can_see(
    client: TestClient, db_session: Session
) -> None:
    """The second P12 failure, and the headline of #170.

    Importing without a key and *then* being sent one used to hide everything
    already imported — the library appeared wiped. A key now gates search and
    import and says nothing about visibility.
    """
    headers = {"X-Install-Id": ALICE}
    _song(db_session, "AddedBeforeTheKey", _install_id(db_session, headers))

    before = client.get("/songs", headers=headers).json()["total"]

    _, token = create_access_key(db_session, "Sent later")
    after = client.get("/songs", headers={**headers, "X-Unlock-Key": token}).json()["total"]

    assert before == 1
    assert after == 1


# --- the boundary itself, one test per read path ----------------------------


def test_an_install_sees_its_own_songs(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, _ = two_installs
    _song(db_session, "Mine", _install_id(db_session, alice))

    body = client.get("/songs", headers=alice).json()
    assert [s["title"] for s in body["items"]] == ["Mine"]


def test_rows_owned_by_nobody_are_invisible_to_an_install(
    client: TestClient, db_session: Session, two_installs
) -> None:
    """Rows predating #170 belong to nobody. Unlike under P12 that is not a shared
    library — it is seen by no client at all, because every client sends an id."""
    alice, _ = two_installs
    _song(db_session, "Orphan", None)

    assert client.get("/songs", headers=alice).json()["total"] == 0


def test_a_request_with_no_install_id_sees_nothing_owned(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, _ = two_installs
    _song(db_session, "Owned", _install_id(db_session, alice))

    assert client.get("/songs").json()["total"] == 0


@pytest.mark.parametrize("suffix", ["", "/audio", "/cover"])
def test_fetching_another_installs_song_is_404_not_403(
    client: TestClient, db_session: Session, two_installs, suffix: str
) -> None:
    """404, not 403: a 403 confirms the row exists, which leaks that somebody else
    has it."""
    alice, bob = two_installs
    song = _song(db_session, "Hers", _install_id(db_session, alice))

    assert client.get(f"/songs/{song.id}{suffix}", headers=bob).status_code == 404


def test_another_installs_song_cannot_be_edited_or_deleted(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, bob = two_installs
    song = _song(db_session, "Hers", _install_id(db_session, alice))

    assert client.patch(f"/songs/{song.id}", json={"title": "x"}, headers=bob).status_code == 404
    assert client.delete(f"/songs/{song.id}", headers=bob).status_code == 404


def test_a_created_playlist_belongs_to_its_creator(client: TestClient, two_installs) -> None:
    alice, bob = two_installs
    assert client.post("/playlists", json={"name": "Alice's"}, headers=alice).status_code == 201

    assert client.get("/playlists", headers=bob).json()["total"] == 0
    assert client.get("/playlists", headers=alice).json()["total"] == 1


def test_favourites_are_per_install_not_global(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, bob = two_installs
    song = _song(db_session, "Mine", _install_id(db_session, alice))

    added = client.post("/playlists/favourites/items", json={"song_id": song.id}, headers=alice)
    assert added.status_code == 201

    assert client.get("/playlists/favourites/song-ids", headers=alice).json()["song_ids"] == [
        song.id
    ]
    assert client.get("/playlists/favourites/song-ids", headers=bob).json()["song_ids"] == []


def test_another_installs_song_cannot_be_hearted(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, bob = two_installs
    song = _song(db_session, "Hers", _install_id(db_session, alice))

    response = client.post("/playlists/favourites/items", json={"song_id": song.id}, headers=bob)
    assert response.status_code == 404


def test_another_installs_song_cannot_be_added_to_a_playlist(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, bob = two_installs
    song = _song(db_session, "Hers", _install_id(db_session, alice))
    playlist = client.post("/playlists", json={"name": "Bob's"}, headers=bob).json()

    response = client.post(
        f"/playlists/{playlist['id']}/items", json={"song_id": song.id}, headers=bob
    )
    assert response.status_code == 404


def test_a_job_belongs_to_the_install_that_created_it(client: TestClient, two_installs) -> None:
    alice, bob = two_installs
    job = client.post("/jobs", json={"url": "https://youtu.be/abc"}, headers=alice).json()

    assert client.get(f"/jobs/{job['id']}", headers=alice).status_code == 200
    assert client.get(f"/jobs/{job['id']}", headers=bob).status_code == 404


def test_playlist_imports_are_isolated(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, bob = two_installs
    db_session.add(
        PlaylistImport(
            service="youtube",
            external_playlist_id="p1",
            name="Alice's",
            owner_install_id=_install_id(db_session, alice),
        )
    )
    db_session.commit()

    assert client.get("/playlist-imports", headers=alice).json()["total"] == 1
    assert client.get("/playlist-imports", headers=bob).json()["total"] == 0


def test_isolation_survives_a_playlist_owned_by_nobody(
    client: TestClient, db_session: Session, two_installs
) -> None:
    alice, _ = two_installs
    db_session.add(Playlist(name="Orphan", owner_install_id=None))
    db_session.commit()

    assert client.get("/playlists", headers=alice).json()["total"] == 0


# --- how installs come into existence --------------------------------------


def test_a_read_does_not_register_an_unknown_install(
    client: TestClient, db_session: Session
) -> None:
    """Reads must not create rows, or every stray or malformed header that reaches
    the server leaves an install behind.

    Counted as a delta: the `client` fixture already registers the suite's own
    install, so an absolute count would measure the fixture rather than the
    behaviour.
    """
    before = db_session.query(Install).count()

    client.get("/songs", headers={"X-Install-Id": "never-seen-before-0123456789"})

    assert db_session.query(Install).count() == before


def test_a_write_registers_the_install_so_there_is_no_sign_up_step(
    client: TestClient, db_session: Session
) -> None:
    """A brand-new client's first import establishes its library. That is what
    lets someone install the app and add a track with nothing else set up."""
    before = db_session.query(Install).count()

    client.post(
        "/jobs",
        json={"url": "https://example.com/x"},
        headers={"X-Install-Id": "brand-new-install-0123456789"},
    )

    assert db_session.query(Install).count() == before + 1


def test_a_token_too_short_to_be_random_is_refused(client: TestClient, db_session: Session) -> None:
    """A short token is either a bug or somebody guessing. Either way it must not
    become an identity, and must not be able to collide with a real one."""
    before = db_session.query(Install).count()

    response = client.post(
        "/jobs", json={"url": "https://example.com/x"}, headers={"X-Install-Id": "abc"}
    )

    # Refused outright rather than silently importing into a black hole.
    assert response.status_code == 400
    assert db_session.query(Install).count() == before


def test_one_install_cannot_release_another_install_s_audio(
    client: TestClient, db_session: Session, two_installs, tmp_path
) -> None:
    """`confirm-receipt` deletes a file, so ownership is load-bearing (#221).

    Every other owned endpoint here only hides rows; getting this one wrong
    would let anyone with a song id destroy somebody else's audio. Asserted on
    the file rather than only on the status code, because a 404 returned *after*
    the unlink would pass a status-only check.
    """
    alice, bob = two_installs
    audio = tmp_path / "alice.opus"
    audio.write_bytes(b"audio")

    song = _song(db_session, "AliceSong", _install_id(db_session, alice))
    song.file_path = str(audio)
    db_session.commit()
    # Register Bob, so the request is refused for *not owning it* rather than
    # for having an install the server has never seen.
    _install_id(db_session, bob)

    response = client.post(f"/songs/{song.id}/confirm-receipt", headers=bob)

    assert response.status_code == 404
    assert audio.exists()
    db_session.expire_all()
    assert db_session.get(Song, song.id).audio_released_at is None
