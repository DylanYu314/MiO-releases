"""Seed a disposable database for the end-to-end tests.

Run before Playwright starts (see frontend/playwright.config.ts). Recreates
the schema from scratch every time, so a run always starts from the same known
state and never depends on — or touches — development data. Point it at a
throwaway database with DATABASE_URL/LIBRARY_PATH.
"""

import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

# The app reads settings at import time, so refuse rather than quietly seeding
# whatever database happens to be configured.
if "e2e" not in os.environ.get("DATABASE_URL", ""):
    sys.exit("refusing to seed: point DATABASE_URL at a disposable e2e database")

from app.db import Base, SessionLocal, engine  # noqa: E402
from app.installs import resolve_install_id  # noqa: E402
from app.models import Playlist, PlaylistItem, Song  # noqa: E402

# Must match the `mio-install-id` value in frontend/playwright.config.ts. The
# seeded library is owned by this install (#170); a mismatch renders every list
# empty rather than failing loudly, so the two are worth keeping side by side.
E2E_INSTALL_TOKEN = "e2e-install-token-0123456789abcdef"

# Enough rows to page (the library shows 24 per page) with recognisable titles.
SONGS = [
    ("Beast of Burden", "The Rolling Stones", "Some Girls", 268.0),
    ("Do It Again", "Steely Dan", "Can't Buy a Thrill", 356.0),
    ("Green River", "Creedence Clearwater Revival", "Green River", 154.0),
    ("Otherside", "Red Hot Chili Peppers", "Californication", 255.0),
    ("Sunny", "Bobby Hebb", "Sunny", 168.0),
]
FILLER_COUNT = 25


def main() -> None:
    library = Path(os.environ["LIBRARY_PATH"])
    library.mkdir(parents=True, exist_ok=True)

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        # Everything seeded belongs to one install (#170). Without an owner the
        # rows are visible to nobody and every e2e list renders empty. The token
        # is pinned in frontend/playwright.config.ts so the browser resolves to
        # this same install.
        owner_id = resolve_install_id(db, E2E_INSTALL_TOKEN, create=True)

        added = datetime.now(UTC)
        songs = []
        catalogue = SONGS + [
            (f"Filler Track {n:02d}", "Various Artists", "Filler", 120.0 + n)
            for n in range(1, FILLER_COUNT + 1)
        ]
        for index, (title, artist, album, duration) in enumerate(catalogue):
            audio = library / f"e2e-{index}.opus"
            audio.write_bytes(b"not really audio")
            song = Song(
                title=title,
                artist=artist,
                album=album,
                duration=duration,
                file_path=str(audio),
                file_hash=f"e2e-hash-{index}",
                source_url=f"https://example.com/watch?v=e2e{index}",
                source_platform="youtube",
                owner_install_id=owner_id,
                # Distinct timestamps so "recently added" has a stable order.
                added_at=added - timedelta(minutes=index),
            )
            db.add(song)
            songs.append(song)
        db.flush()

        playlist = Playlist(name="Seeded Playlist", owner_install_id=owner_id)
        db.add(playlist)
        db.flush()
        db.add(PlaylistItem(playlist_id=playlist.id, song_id=songs[0].id, position=0))

        db.commit()
        print(f"seeded {len(songs)} songs and 1 playlist into {os.environ['DATABASE_URL']}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
