import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect

from app.events import job_events
from app.models import ImportJob, ImportStatus
from app.routers.jobs import WS_CLOSE_JOB_NOT_FOUND
from app.schemas import JobRead
from tests.conftest import TEST_INSTALL_TOKEN


def _create_job(
    db_session: Session,
    install_id: int,
    status: ImportStatus = ImportStatus.QUEUED,
) -> ImportJob:
    job = ImportJob(
        source_url="https://example.com/watch?v=abc", status=status, owner_install_id=install_id
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def _payload(job: ImportJob, status: ImportStatus) -> dict:
    job.status = status
    return JobRead.model_validate(job).model_dump(mode="json")


def test_sends_current_state_immediately_on_connect(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    """A client connecting mid-import shouldn't wait for the next transition."""
    job = _create_job(db_session, install_id, ImportStatus.CONVERTING)

    with client.websocket_connect(f"/jobs/{job.id}/ws?install={TEST_INSTALL_TOKEN}") as websocket:
        message = websocket.receive_json()

    assert message["id"] == job.id
    assert message["status"] == "converting"


def test_streams_updates_as_they_are_published(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    job = _create_job(db_session, install_id)

    with client.websocket_connect(f"/jobs/{job.id}/ws?install={TEST_INSTALL_TOKEN}") as websocket:
        assert websocket.receive_json()["status"] == "queued"

        job_events.publish(job.id, _payload(job, ImportStatus.DOWNLOADING))
        assert websocket.receive_json()["status"] == "downloading"

        job_events.publish(job.id, _payload(job, ImportStatus.TAGGING))
        assert websocket.receive_json()["status"] == "tagging"


def test_closes_once_the_job_reaches_a_terminal_state(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    job = _create_job(db_session, install_id)

    with client.websocket_connect(f"/jobs/{job.id}/ws?install={TEST_INSTALL_TOKEN}") as websocket:
        websocket.receive_json()
        job_events.publish(job.id, _payload(job, ImportStatus.DONE))

        assert websocket.receive_json()["status"] == "done"
        with pytest.raises(WebSocketDisconnect):
            websocket.receive_json()


def test_closes_straight_away_for_an_already_finished_job(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    job = _create_job(db_session, install_id, ImportStatus.FAILED)

    with client.websocket_connect(f"/jobs/{job.id}/ws?install={TEST_INSTALL_TOKEN}") as websocket:
        assert websocket.receive_json()["status"] == "failed"
        with pytest.raises(WebSocketDisconnect):
            websocket.receive_json()


def test_rejects_an_unknown_job(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"/jobs/999999/ws?install={TEST_INSTALL_TOKEN}") as websocket:
            websocket.receive_json()

    assert exc_info.value.code == WS_CLOSE_JOB_NOT_FOUND


def test_unsubscribes_after_the_client_disconnects(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    """Otherwise a long-running process leaks a queue per connection."""
    job = _create_job(db_session, install_id)

    with client.websocket_connect(f"/jobs/{job.id}/ws?install={TEST_INSTALL_TOKEN}") as websocket:
        websocket.receive_json()

    assert job_events.subscriber_count(job.id) == 0


def test_two_clients_watching_the_same_job_both_get_updates(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    job = _create_job(db_session, install_id)

    with (
        client.websocket_connect(f"/jobs/{job.id}/ws?install={TEST_INSTALL_TOKEN}") as first,
        client.websocket_connect(f"/jobs/{job.id}/ws?install={TEST_INSTALL_TOKEN}") as second,
    ):
        first.receive_json()
        second.receive_json()

        job_events.publish(job.id, _payload(job, ImportStatus.DOWNLOADING))

        assert first.receive_json()["status"] == "downloading"
        assert second.receive_json()["status"] == "downloading"


def test_another_install_cannot_watch_your_job(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    """⚠️ The #514 leak, pinned.

    `GET /jobs/{id}` scoped by `owned_by` and this socket did not — the same
    resource, two representations, one guarded. `JobRead` carries
    `source_url`, and ids are sequential integers, so anyone able to reach the
    server could walk them and read what was being downloaded.
    """
    job = _create_job(db_session, install_id, ImportStatus.DOWNLOADING)

    with pytest.raises(WebSocketDisconnect) as caught:
        with client.websocket_connect(f"/jobs/{job.id}/ws?install=someone-elses-token") as ws:
            ws.receive_json()
    # Indistinguishable from a job that does not exist, on purpose: a distinct
    # code would confirm the id was real.
    assert caught.value.code == WS_CLOSE_JOB_NOT_FOUND


def test_no_install_at_all_cannot_watch_a_job(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    # `owned_by(model, None)` means *no rows*, not "the rows nobody owns"
    # (#170). Omitting the parameter must therefore see nothing.
    job = _create_job(db_session, install_id, ImportStatus.DOWNLOADING)

    with pytest.raises(WebSocketDisconnect) as caught:
        with client.websocket_connect(f"/jobs/{job.id}/ws") as ws:
            ws.receive_json()
    assert caught.value.code == WS_CLOSE_JOB_NOT_FOUND
