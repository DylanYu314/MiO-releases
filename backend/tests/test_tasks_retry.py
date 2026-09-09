"""The retry policy that sits between Celery and the pipeline."""

import pytest
from celery.exceptions import Retry
from sqlalchemy.orm import Session

import app.tasks as tasks
from app.models import ImportJob, ImportStatus
from app.tasks import _retry_delay, import_job_task
from app.ytdlp import ExtractionError, TransientExtractionError


@pytest.fixture
def job(db_session: Session) -> ImportJob:
    row = ImportJob(source_url="https://example.com/watch?v=abc", status=ImportStatus.QUEUED)
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def test_backoff_grows_with_each_attempt() -> None:
    """An immediate retry would hit the same throttling that just refused us."""
    delays = [_retry_delay(attempt) for attempt in range(3)]

    assert delays == sorted(delays)
    assert len(set(delays)) == 3
    assert delays[0] > 0


def test_a_successful_run_does_not_retry(job: ImportJob, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[int] = []
    monkeypatch.setattr(tasks, "run_import_job", calls.append)

    import_job_task(job.id)

    assert calls == [job.id]


def test_a_transient_failure_asks_celery_to_retry_with_backoff(
    job: ImportJob, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _throttled(job_id: int) -> None:
        raise TransientExtractionError("HTTP Error 403: Forbidden")

    monkeypatch.setattr(tasks, "run_import_job", _throttled)

    requested: dict[str, object] = {}

    def _fake_retry(exc: Exception | None = None, countdown: int | None = None, **kwargs: object):
        requested["countdown"] = countdown
        raise Retry()

    # Stubbed because Celery's eager mode (what tests run in) re-raises the
    # original error instead of Retry, hiding whether we asked for one.
    monkeypatch.setattr(import_job_task, "retry", _fake_retry)

    import_job_task.push_request(retries=0)
    try:
        with pytest.raises(Retry):
            import_job_task(job.id)
    finally:
        import_job_task.pop_request()

    assert requested["countdown"] == _retry_delay(0)


def test_a_permanent_failure_is_not_retried(
    job: ImportJob, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pipeline already recorded it on the job; retrying a private video
    would just burn attempts."""

    def _unavailable(job_id: int) -> None:
        raise ExtractionError("Video unavailable")

    monkeypatch.setattr(tasks, "run_import_job", _unavailable)

    with pytest.raises(ExtractionError):
        import_job_task(job.id)


def test_giving_up_marks_the_job_failed(
    job: ImportJob, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Otherwise an exhausted job sits in `queued` forever, looking like it's
    still coming."""

    def _throttled(job_id: int) -> None:
        raise TransientExtractionError("HTTP Error 403: Forbidden")

    monkeypatch.setattr(tasks, "run_import_job", _throttled)

    # Pretend this is the final attempt.
    import_job_task.push_request(retries=import_job_task.max_retries)
    try:
        import_job_task(job.id)  # must not raise
    finally:
        import_job_task.pop_request()

    db_session.expire_all()
    refreshed = db_session.get(ImportJob, job.id)
    assert refreshed is not None
    assert refreshed.status == ImportStatus.FAILED
    assert "Gave up after" in (refreshed.error or "")


def test_downloads_are_rate_limited() -> None:
    """Pacing is what stops a large import provoking the throttling in the
    first place."""
    assert import_job_task.rate_limit
