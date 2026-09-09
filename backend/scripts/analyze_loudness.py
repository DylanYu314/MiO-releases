"""Backfill EBU R128 measurements for songs imported before G4.

Run with -m, never as a path:

    docker compose exec backend python -m scripts.analyze_loudness
    docker compose exec backend python -m scripts.analyze_loudness --force

As a path, sys.path[0] becomes scripts/ and `app` resolves to the *installed*
copy in site-packages, which goes stale the moment a model changes — this
project has already lost a debugging session to exactly that.
"""

import argparse
import logging
import sys
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.loudness import LoudnessError, analyze
from app.models import Song

logger = logging.getLogger("analyze_loudness")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-analyse songs that already have a measurement",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="stop after this many songs (useful for a first look)",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")

    db = SessionLocal()
    try:
        query = select(Song).order_by(Song.id)
        if not args.force:
            query = query.where(Song.loudness_lufs.is_(None))
        songs = list(db.scalars(query))
        if args.limit is not None:
            songs = songs[: args.limit]

        if not songs:
            print("Nothing to analyse — every song already has a measurement.")
            return 0

        print(f"Analysing {len(songs)} song(s)...")
        measured = silent = failed = missing = 0

        for index, song in enumerate(songs, start=1):
            path = Path(song.file_path)
            if not path.exists():
                missing += 1
                print(f"  [{index}/{len(songs)}] {song.id} {song.title[:40]!r}: file missing")
                continue

            try:
                result = analyze(path)
            except LoudnessError as exc:
                failed += 1
                print(f"  [{index}/{len(songs)}] {song.id} {song.title[:40]!r}: FAILED")
                logger.debug("analysis failed for %s: %s", path, exc)
                continue

            if result is None:
                # Recorded as analysed-but-silent by leaving the columns null;
                # --force is the way to try again.
                silent += 1
                print(f"  [{index}/{len(songs)}] {song.id} {song.title[:40]!r}: no usable level")
                continue

            song.loudness_lufs = result.lufs
            song.peak_dbfs = result.peak_dbfs
            measured += 1
            print(
                f"  [{index}/{len(songs)}] {song.id} {song.title[:40]!r}: "
                f"{result.lufs:.1f} LUFS, peak {result.peak_dbfs:.1f} dBFS"
            )

            # Commit as we go: a long backfill interrupted halfway should keep
            # what it has measured rather than starting over.
            db.commit()

        print(f"\nDone. measured={measured} silent={silent} failed={failed} missing={missing}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
