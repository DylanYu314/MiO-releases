import hashlib
import logging
import shutil
from pathlib import Path

from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.events import job_events
from app.loudness import LoudnessError
from app.loudness import analyze as analyze_loudness
from app.models import ImportJob, ImportStatus, Song
from app.schemas import JobRead
from app.tagging import write_tags
from app.transcode import to_opus
from app.ytdlp import TransientExtractionError, extract_and_download

logger = logging.getLogger(__name__)


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _advance(job: ImportJob, status: ImportStatus, db: Session) -> None:
    """Move the job to `status`, persist it, then tell any WebSocket listeners.

    The commit happens first so the DB — the source of truth — is already
    updated if publishing fails or nobody is listening.
    """
    job.status = status
    db.commit()
    db.refresh(job)
    logger.info("job status", extra={"job_id": job.id, "status": status.value})
    job_events.publish(job.id, JobRead.model_validate(job).model_dump(mode="json"))


def mark_job_failed(job_id: int, error: str) -> None:
    """Record a terminal failure decided outside the pipeline — currently when
    the task layer runs out of retries."""
    db = SessionLocal()
    try:
        job = db.get(ImportJob, job_id)
        if job is None:
            return
        job.error = error
        _advance(job, ImportStatus.FAILED, db)
    finally:
        db.close()


def run_import_job(job_id: int) -> None:
    """Drive an ImportJob through queued -> downloading -> converting -> tagging -> done/failed.

    Runs inside a Celery worker. Permanent failures are recorded on the job
    rather than raised — an uncaught exception would leave the job looking
    stuck forever. The one exception is a *transient* failure (throttling, a
    timeout): the job is put back to `queued` and the error re-raised, so the
    task layer can retry it (ADR-006).
    """
    settings = get_settings()
    db = SessionLocal()
    library_path = Path(settings.library_path)
    tmp_dir = library_path / "_tmp" / str(job_id)
    try:
        job = db.get(ImportJob, job_id)
        if job is None:
            return

        try:
            library_path.mkdir(parents=True, exist_ok=True)

            _advance(job, ImportStatus.DOWNLOADING, db)
            extracted = extract_and_download(job.source_url, tmp_dir)

            _advance(job, ImportStatus.CONVERTING, db)
            dest_path = library_path / f"{job_id}.opus"
            to_opus(extracted.file_path, dest_path)

            _advance(job, ImportStatus.TAGGING, db)
            cover_dest = None
            if extracted.thumbnail_path is not None:
                cover_dest = library_path / f"{job_id}{extracted.thumbnail_path.suffix}"
                shutil.copy(extracted.thumbnail_path, cover_dest)
            write_tags(
                dest_path,
                title=extracted.title,
                artist=extracted.artist,
                album=extracted.album,
                cover_path=cover_dest,
            )

            # Loudness is a nicety, not a reason to fail an import: a track
            # with no measurement simply plays uncorrected.
            loudness = None
            try:
                loudness = analyze_loudness(dest_path)
            except LoudnessError as exc:
                logger.warning(
                    "loudness analysis failed",
                    extra={"job_id": job_id, "error": str(exc)},
                )

            song = Song(
                title=extracted.title,
                artist=extracted.artist,
                album=extracted.album,
                duration=extracted.duration,
                file_path=str(dest_path),
                file_hash=_hash_file(dest_path),
                source_url=job.source_url,
                source_platform=extracted.source_platform,
                cover_path=str(cover_dest) if cover_dest else None,
                loudness_lufs=loudness.lufs if loudness else None,
                peak_dbfs=loudness.peak_dbfs if loudness else None,
                # The song belongs to whoever asked for the job (P12).
                owner_install_id=job.owner_install_id,
            )
            db.add(song)
            db.flush()

            job.song_id = song.id
            _advance(job, ImportStatus.DONE, db)
        except TransientExtractionError as exc:
            # Worth another go: park it back in the queue, keep the reason
            # visible, and let the caller decide whether to retry.
            logger.warning(
                "transient download failure",
                extra={"job_id": job_id, "url": job.source_url, "error": str(exc)},
            )
            job.error = str(exc)
            _advance(job, ImportStatus.QUEUED, db)
            raise
        except Exception as exc:
            logger.error(
                "job failed",
                extra={"job_id": job_id, "url": job.source_url, "error": str(exc)},
            )
            job.error = str(exc)
            _advance(job, ImportStatus.FAILED, db)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
    finally:
        db.close()
