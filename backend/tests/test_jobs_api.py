import pytest
from fastapi.testclient import TestClient

import app.routers.jobs as jobs_router


@pytest.fixture(autouse=True)
def _stub_enqueue(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests focused on the request/DB contract: record that the task
    was enqueued instead of running the real pipeline."""
    monkeypatch.setattr(jobs_router.import_job_task, "delay", lambda job_id: None)


def test_create_job_returns_queued_job(client: TestClient) -> None:
    response = client.post("/jobs", json={"url": "https://example.com/watch?v=abc"})

    assert response.status_code == 201
    body = response.json()
    assert body["source_url"] == "https://example.com/watch?v=abc"
    assert body["status"] == "queued"
    assert body["song_id"] is None
    assert body["error"] is None


def test_get_job_returns_created_job(client: TestClient) -> None:
    create_response = client.post("/jobs", json={"url": "https://example.com/watch?v=xyz"})
    job_id = create_response.json()["id"]

    get_response = client.get(f"/jobs/{job_id}")

    assert get_response.status_code == 200
    assert get_response.json()["id"] == job_id


def test_get_unknown_job_returns_404(client: TestClient) -> None:
    response = client.get("/jobs/999999")

    assert response.status_code == 404
