"""A hung extraction fails instead of wedging the worker (#213).

Tasks acknowledge late (ADR-006) and the worker runs `--concurrency=2`, so an
extraction that never returns holds a slot forever — `restart: unless-stopped`
does not help, because a hung worker never exits. Two of those and every later
import sits at `queued`, which reads as "still coming" rather than "this
failed".

## What is tested, and what cannot be

Celery enforces the limits in the worker, and the suite runs tasks eagerly
(`REDIS_URL` cleared in conftest), so **nothing here can make a real timeout
happen**. Asserting on the configuration and on the handler is the honest
substitute: that the limits are attached to the right task, that they are
absent from the ones that would break, and that the exception is turned into a
recorded failure with a reason a person can read.
"""

import pytest
from celery.exceptions import SoftTimeLimitExceeded

from app.config import get_settings
from app.failures import classify_failure
from app.models import ImportJob, ImportStatus
from app.tasks import (
    confirmed_import_task,
    import_job_task,
    playlist_import_task,
    retry_failed_matches_task,
)


def test_a_single_import_has_both_limits() -> None:
    settings = get_settings()

    assert import_job_task.soft_time_limit == settings.download_soft_time_limit_seconds
    assert import_job_task.time_limit == settings.download_time_limit_seconds
    # The soft limit must land first, or the process is killed before the task
    # can record why — which is the whole point of having a soft one.
    assert import_job_task.soft_time_limit < import_job_task.time_limit


def test_the_limit_is_well_clear_of_a_real_import() -> None:
    # Measured imports run 13-20s on the server. The ceiling exists to bound a
    # wedge, not to enforce speed: set close to real work, a long track on a
    # slow day fails for no reason at all.
    assert get_settings().download_soft_time_limit_seconds >= 120


@pytest.mark.parametrize(
    "task",
    [playlist_import_task, confirmed_import_task, retry_failed_matches_task],
    ids=lambda task: task.name,
)
def test_playlist_tasks_are_not_limited(task) -> None:
    """The trap in "just add a time limit".

    `run_confirmed_import` downloads a **whole playlist inside one task** — a
    hundred tracks paced a few seconds apart is half an hour of entirely
    legitimate work. A limit sized for one song, or a Celery-wide setting, kills
    every batch import while looking like a safety improvement.
    """
    assert task.soft_time_limit is None
    assert task.time_limit is None


def test_a_timeout_is_recorded_as_a_failure(db_session, monkeypatch: pytest.MonkeyPatch) -> None:
    job = ImportJob(source_url="https://youtube.com/watch?v=x", status=ImportStatus.QUEUED)
    db_session.add(job)
    db_session.commit()
    job_id = job.id

    def hang(_job_id: int) -> None:
        raise SoftTimeLimitExceeded()

    monkeypatch.setattr("app.tasks.run_import_job", hang)

    # Deliberately does not raise: the task swallows it having recorded the
    # reason, so the worker slot returns cleanly.
    import_job_task(job_id)

    db_session.expire_all()
    stored = db_session.get(ImportJob, job_id)
    assert stored.status == ImportStatus.FAILED
    assert "Timed out" in stored.error


def test_the_recorded_reason_is_one_a_client_can_translate() -> None:
    # `error_code` is derived from the message (see failures.py), so the wording
    # above and the rule are one unit — changing either alone silently drops the
    # user back to raw text.
    assert classify_failure("Timed out after 180s — the source took too long to respond") == (
        "took_too_long"
    )


def test_a_socket_timeout_is_still_a_network_failure() -> None:
    # A read giving up is not the import being abandoned, and the two want
    # different advice. `took_too_long` is ordered before `network` precisely
    # because both contain "timed out".
    assert classify_failure("ERROR: unable to download video data: read timed out") == "network"
