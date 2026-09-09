import os
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

_tmp_root = tempfile.mkdtemp(prefix="mio-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp_root}/test.db"
os.environ["LIBRARY_PATH"] = f"{_tmp_root}/library"
# No broker in tests: tasks run inline (where they aren't stubbed) and progress
# events are delivered in-process, so the suite needs no Redis (ADR-006).
os.environ["REDIS_URL"] = ""
# Real downloads are paced; tests fake them, so don't sleep between them.
os.environ["DOWNLOAD_PACING_SECONDS"] = "0"
# Pin the access-key gate off so the suite doesn't depend on a local .env that
# happens to set REQUIRE_ACCESS_KEY (ADR-009) — the gate tests toggle it via keys.
os.environ["REQUIRE_ACCESS_KEY"] = "false"
# Same reason: a developer with a POT provider configured locally (#161) would
# otherwise fail the test asserting the unconfigured path adds nothing. The
# tests that want it set it themselves.
os.environ["YTDLP_POT_PROVIDER_URL"] = ""
# And the same again for Google (#106). This one was found the hard way: adding
# real credentials to a local .env turned three passing tests red, because the
# suite was reading the developer's file and "unconfigured" quietly meant
# "however this laptop happens to be set up". Tests that want the configured
# path build their own Settings and override the dependency.
# The suite makes far more requests from one address than any user would, so
# the inbound limit (#514) is off here and exercised by its own tests instead.
# ⚠️ Must be set *before* `app.main` is imported below: the middleware is added
# at import time from an `@lru_cache`d `get_settings()`, so setting it later
# would be read by nothing and the suite would fail in a way that looks like a
# product bug.
os.environ["RATE_LIMIT_PER_MINUTE"] = "0"
os.environ["GOOGLE_CLIENT_ID"] = ""
os.environ["GOOGLE_CLIENT_SECRET"] = ""

from app.db import Base, SessionLocal, engine, get_db  # noqa: E402
from app.installs import resolve_install_id  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Song  # noqa: E402

# Every real client carries one of these (#170), so the fixtures below give the
# suite one too. Without it `owned_by` resolves to "no rows" and every test that
# reads anything sees an empty library — which is correct behaviour, but not what
# a test about pagination or Range requests is trying to exercise.
TEST_INSTALL_TOKEN = "conftest-install-token-0123456789"


@pytest.fixture(autouse=True)
def _clean_schema() -> Iterator[None]:
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture
def db_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def install_id(db_session: Session) -> int:
    """The suite's default install, registered so reads resolve to it."""
    resolved = resolve_install_id(db_session, TEST_INSTALL_TOKEN, create=True)
    assert resolved is not None
    return resolved


@pytest.fixture
def client(install_id: int) -> Iterator[TestClient]:
    def _override_get_db() -> Iterator[Session]:
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _override_get_db
    # Sent on every request, exactly as a real client does. Tests that care about
    # a *different* install, or none, pass their own headers per request — those
    # override these defaults.
    with TestClient(app, headers={"X-Install-Id": TEST_INSTALL_TOKEN}) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture
def library_path() -> Path:
    path = Path(os.environ["LIBRARY_PATH"])
    path.mkdir(parents=True, exist_ok=True)
    return path


@pytest.fixture
def make_song(db_session: Session, library_path: Path, install_id: int) -> Callable[..., Song]:
    """Factory for Song rows, with real (dummy) files on disk by default."""
    counter = 0

    def _make(
        title: str = "Test Song",
        artist: str = "Test Artist",
        album: str | None = "Test Album",
        duration: float | None = 100.0,
        with_files: bool = True,
    ) -> Song:
        nonlocal counter
        counter += 1
        audio_path = library_path / f"song-{counter}.opus"
        cover_path = library_path / f"song-{counter}.jpg"
        if with_files:
            audio_path.write_bytes(b"fake-opus-bytes")
            cover_path.write_bytes(b"fake-cover-bytes")

        song = Song(
            title=title,
            artist=artist,
            album=album,
            duration=duration,
            file_path=str(audio_path),
            file_hash=f"hash-{counter}",
            source_url=f"https://example.com/watch?v={counter}",
            source_platform="youtube",
            cover_path=str(cover_path) if with_files else None,
            owner_install_id=install_id,
        )
        db_session.add(song)
        db_session.commit()
        db_session.refresh(song)
        return song

    return _make
