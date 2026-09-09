import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect

from app.events import playlist_import_events
from app.models import PlaylistImport, PlaylistImportStatus
from app.routers.playlist_imports import WS_CLOSE_IMPORT_NOT_FOUND
from app.schemas import PlaylistImportRead
from tests.conftest import TEST_INSTALL_TOKEN


def _create_import(
    db_session: Session,
    install_id: int,
    status: PlaylistImportStatus = PlaylistImportStatus.QUEUED,
) -> PlaylistImport:
    row = PlaylistImport(
        service="spotify",
        external_playlist_id="pl-1",
        name="Road Trip",
        status=status,
        owner_install_id=install_id,
    )
    db_session.add(row)
    db_session.commit()
    db_session.refresh(row)
    return row


def _payload(playlist_import: PlaylistImport, status: PlaylistImportStatus) -> dict:
    playlist_import.status = status
    return PlaylistImportRead.model_validate(playlist_import).model_dump(mode="json")


def test_sends_current_state_immediately_on_connect(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    playlist_import = _create_import(db_session, install_id, PlaylistImportStatus.MATCHING)

    with client.websocket_connect(
        f"/playlist-imports/{playlist_import.id}/ws?install={TEST_INSTALL_TOKEN}"
    ) as websocket:
        message = websocket.receive_json()

    assert message["id"] == playlist_import.id
    assert message["status"] == "matching"


def test_streams_updates_as_they_are_published(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    playlist_import = _create_import(db_session, install_id)

    with client.websocket_connect(
        f"/playlist-imports/{playlist_import.id}/ws?install={TEST_INSTALL_TOKEN}"
    ) as websocket:
        assert websocket.receive_json()["status"] == "queued"

        playlist_import_events.publish(
            playlist_import.id, _payload(playlist_import, PlaylistImportStatus.FETCHING)
        )
        assert websocket.receive_json()["status"] == "fetching"

        playlist_import_events.publish(
            playlist_import.id, _payload(playlist_import, PlaylistImportStatus.REVIEW)
        )
        assert websocket.receive_json()["status"] == "review"


def test_closes_once_the_import_reaches_a_terminal_state(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    playlist_import = _create_import(db_session, install_id)

    with client.websocket_connect(
        f"/playlist-imports/{playlist_import.id}/ws?install={TEST_INSTALL_TOKEN}"
    ) as websocket:
        websocket.receive_json()
        playlist_import_events.publish(
            playlist_import.id, _payload(playlist_import, PlaylistImportStatus.FAILED)
        )

        assert websocket.receive_json()["status"] == "failed"
        with pytest.raises(WebSocketDisconnect):
            websocket.receive_json()


def test_review_is_not_terminal(client: TestClient, db_session: Session, install_id: int) -> None:
    """`review` waits for the user — the socket must stay open through it."""
    playlist_import = _create_import(db_session, install_id, PlaylistImportStatus.REVIEW)

    with client.websocket_connect(
        f"/playlist-imports/{playlist_import.id}/ws?install={TEST_INSTALL_TOKEN}"
    ) as websocket:
        assert websocket.receive_json()["status"] == "review"

        playlist_import_events.publish(
            playlist_import.id, _payload(playlist_import, PlaylistImportStatus.IMPORTING)
        )
        assert websocket.receive_json()["status"] == "importing"


def test_rejects_an_unknown_import(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(
            f"/playlist-imports/999999/ws?install={TEST_INSTALL_TOKEN}"
        ) as websocket:
            websocket.receive_json()

    assert exc_info.value.code == WS_CLOSE_IMPORT_NOT_FOUND


def test_unsubscribes_after_the_client_disconnects(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    playlist_import = _create_import(db_session, install_id)

    with client.websocket_connect(
        f"/playlist-imports/{playlist_import.id}/ws?install={TEST_INSTALL_TOKEN}"
    ) as websocket:
        websocket.receive_json()

    assert playlist_import_events.subscriber_count(playlist_import.id) == 0


def test_another_install_cannot_watch_your_import(
    client: TestClient, db_session: Session, install_id: int
) -> None:
    """The same #514 leak as the jobs socket, which this file is a clone of.

    `PlaylistImportRead` carries the playlist's name, so an unscoped read told
    anyone who could guess a sequential id what somebody was importing.
    """
    row = _create_import(db_session, install_id, PlaylistImportStatus.MATCHING)

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(
            f"/playlist-imports/{row.id}/ws?install=someone-elses-token"
        ) as ws:
            ws.receive_json()
