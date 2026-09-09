"""Celery tasks — thin wrappers over the pipeline functions.

Deliberately thin: the pipelines in app/jobs.py and app/playlist_imports.py
know nothing about Celery, so they stay callable (and testable) as ordinary
functions. This module is the seam that lets a router hand work to a worker
process, and the place where retry policy and per-task logging context live.
"""

import logging
import time
from collections.abc import Iterator
from contextlib import contextmanager

from celery import Task
from celery.exceptions import SoftTimeLimitExceeded

from app.celery_app import celery_app
from app.config import get_settings
from app.jobs import mark_job_failed, run_import_job
from app.logging_config import log_context
from app.pacing import retry_backoff_seconds
from app.playlist_imports import (
    run_confirmed_import,
    run_playlist_import,
    run_retry_failed_matches,
)
from app.ytdlp import TransientExtractionError

logger = logging.getLogger(__name__)

settings = get_settings()

# The backoff now lives in app.pacing so the inline batch retry (B3) waits the
# same way; kept here under its original name for existing callers/tests.
_retry_delay = retry_backoff_seconds


@contextmanager
def _task_logging(task_name: str, **context: object) -> Iterator[None]:
    """Bind ids to every line the task writes, and record how it ended."""
    started = time.perf_counter()
    with log_context(task=task_name, **context):
        logger.info("task started")
        try:
            yield
        except Exception:
            logger.exception(
                "task failed",
                extra={"duration_ms": round((time.perf_counter() - started) * 1000, 1)},
            )
            raise
        logger.info(
            "task finished",
            extra={"duration_ms": round((time.perf_counter() - started) * 1000, 1)},
        )


@celery_app.task(
    bind=True,
    name="mio.import_job",
    max_retries=settings.download_max_retries,
    # Paces downloads across a batch, so we stop provoking the throttling
    # that this retry logic then has to clean up after.
    rate_limit=settings.download_rate_limit,
    # Per task, not global (#213). A playlist import legitimately runs for tens
    # of minutes inside one task, so a limit sized for a single song must not
    # reach it — which is exactly what a Celery-wide setting would do.
    soft_time_limit=settings.download_soft_time_limit_seconds,
    time_limit=settings.download_time_limit_seconds,
)
def import_job_task(self: Task, job_id: int) -> None:
    with _task_logging("import_job", job_id=job_id, attempt=self.request.retries):
        try:
            run_import_job(job_id)
        except SoftTimeLimitExceeded:
            # The whole point of the soft limit: the slot is freed *and* the
            # user is told. Without this the extraction hangs forever, the
            # worker slot never returns, and the job sits at `queued` — which
            # reads as "still coming" rather than "this failed".
            #
            # Not retried. A hang is not a transient network blip, and retrying
            # would spend the same three minutes again on the way to the same
            # answer.
            logger.warning("import timed out")
            mark_job_failed(
                job_id,
                f"Timed out after {settings.download_soft_time_limit_seconds}s "
                "— the source took too long to respond",
            )
            return
        except TransientExtractionError as exc:
            if self.request.retries >= self.max_retries:
                # Out of attempts: record why, so the job doesn't sit in
                # `queued` looking like it's still coming.
                logger.warning("giving up after retries", extra={"error": str(exc)})
                mark_job_failed(job_id, f"Gave up after {self.max_retries} retries: {exc}")
                return
            delay = _retry_delay(self.request.retries)
            logger.info(
                "retrying after transient failure",
                extra={"retry_in_seconds": delay, "error": str(exc)},
            )
            raise self.retry(exc=exc, countdown=delay) from exc


@celery_app.task(name="mio.playlist_import")
def playlist_import_task(playlist_import_id: int) -> None:
    with _task_logging("playlist_import", playlist_import_id=playlist_import_id):
        run_playlist_import(playlist_import_id)


@celery_app.task(name="mio.confirmed_import")
def confirmed_import_task(playlist_import_id: int) -> None:
    with _task_logging("confirmed_import", playlist_import_id=playlist_import_id):
        run_confirmed_import(playlist_import_id)


@celery_app.task(name="mio.retry_failed_matches")
def retry_failed_matches_task(playlist_import_id: int, match_ids: list[int]) -> None:
    with _task_logging("retry_failed_matches", playlist_import_id=playlist_import_id):
        run_retry_failed_matches(playlist_import_id, match_ids)
