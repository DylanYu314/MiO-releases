import pytest
from fastapi.testclient import TestClient

import app.routers.search as search_router
from app.ytdlp import ExtractionError, SearchResult, TransientExtractionError


def fake_results(*titles: str) -> list[SearchResult]:
    return [
        SearchResult(url=f"https://y/{i}", title=title, uploader="Chan", duration=200.0)
        for i, title in enumerate(titles)
    ]


def test_search_returns_mapped_results(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    def fake_search(query: str, limit: int, platform: str) -> list[SearchResult]:
        captured.update(query=query, limit=limit, platform=platform)
        return fake_results("Song A", "Song B")

    monkeypatch.setattr(search_router, "search", fake_search)

    response = client.get("/search", params={"q": "rick astley"})

    assert response.status_code == 200
    body = response.json()
    assert [item["title"] for item in body] == ["Song A", "Song B"]
    assert body[0]["url"] == "https://y/0"
    # Defaults: youtube, the router's default limit.
    assert captured == {"query": "rick astley", "limit": 10, "platform": "youtube"}


def test_search_passes_platform_and_limit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict = {}

    def fake_search(query: str, limit: int, platform: str) -> list[SearchResult]:
        captured.update(limit=limit, platform=platform)
        return []

    monkeypatch.setattr(search_router, "search", fake_search)

    response = client.get("/search", params={"q": "x", "platform": "bilibili", "limit": 5})

    assert response.status_code == 200
    assert captured == {"limit": 5, "platform": "bilibili"}


def test_search_requires_a_query(client: TestClient) -> None:
    assert client.get("/search").status_code == 422
    assert client.get("/search", params={"q": ""}).status_code == 422


def test_search_rejects_an_unknown_platform(client: TestClient) -> None:
    response = client.get("/search", params={"q": "x", "platform": "soundcloud"})
    assert response.status_code == 422


def test_search_rejects_out_of_range_limits(client: TestClient) -> None:
    assert client.get("/search", params={"q": "x", "limit": 0}).status_code == 422
    assert client.get("/search", params={"q": "x", "limit": 100}).status_code == 422


def test_search_reports_upstream_failure_as_502(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(query: str, limit: int, platform: str) -> list[SearchResult]:
        raise ExtractionError("search blocked")

    monkeypatch.setattr(search_router, "search", boom)

    response = client.get("/search", params={"q": "x"})

    assert response.status_code == 502
    assert "search blocked" in response.json()["detail"]


def test_rate_limiting_answers_503_not_502(client, monkeypatch):
    """Bilibili's 412 is frequent and temporary, so it must not read as a fault.

    Measured live: roughly half of spaced requests are refused, and the same
    query succeeds a minute later. A 502 with a raw yt-dlp string would be the
    common case rather than the exception.
    """

    def _throttled(*_args, **_kwargs):
        raise TransientExtractionError("HTTP Error 412: Precondition Failed")

    monkeypatch.setattr(search_router, "search", _throttled)

    response = client.get("/search", params={"q": "稻香", "platform": "bilibili"})

    assert response.status_code == 503
    assert "try again" in response.json()["detail"].lower()
    # The extractor's own wording never reaches the user.
    assert "412" not in response.json()["detail"]


def test_permanent_extraction_failure_still_answers_502(client, monkeypatch):
    def _broken(*_args, **_kwargs):
        raise ExtractionError("Unsupported URL")

    monkeypatch.setattr(search_router, "search", _broken)

    response = client.get("/search", params={"q": "x"})

    assert response.status_code == 502
