"""The inbound request limit (#514).

⚠️ The limiter is disabled for the rest of the suite (`conftest.py`), so
everything here builds its own — otherwise these tests would assert against a
middleware that is not installed and pass for the wrong reason.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.rate_limit import EXEMPT_PATHS, RateLimitMiddleware, SlidingWindowLimiter, client_key


class TestSlidingWindow:
    def test_allows_up_to_the_limit(self) -> None:
        limiter = SlidingWindowLimiter(limit=3, window_seconds=60)
        assert [limiter.check("a", 0.0) for _ in range(3)] == [None, None, None]

    def test_refuses_the_one_after(self) -> None:
        limiter = SlidingWindowLimiter(limit=3, window_seconds=60)
        for _ in range(3):
            limiter.check("a", 0.0)
        assert limiter.check("a", 0.0) == pytest.approx(60.0)

    def test_callers_are_counted_separately(self) -> None:
        # The whole point of keying on the client: one noisy caller must not
        # lock out everybody else.
        limiter = SlidingWindowLimiter(limit=1, window_seconds=60)
        assert limiter.check("a", 0.0) is None
        assert limiter.check("a", 0.0) is not None
        assert limiter.check("b", 0.0) is None

    def test_the_window_slides_rather_than_resetting(self) -> None:
        """A fixed window lets a caller send the whole allowance at 59.9 s and
        again at 60.1 s — twice the limit across one second."""
        limiter = SlidingWindowLimiter(limit=2, window_seconds=10)
        limiter.check("a", 0.0)
        limiter.check("a", 9.0)
        # Still inside the window for both.
        assert limiter.check("a", 9.5) is not None
        # The first has aged out; the second has not.
        assert limiter.check("a", 10.5) is None
        assert limiter.check("a", 10.6) is not None

    def test_history_does_not_grow_without_bound(self) -> None:
        limiter = SlidingWindowLimiter(limit=2, window_seconds=1)
        for i in range(500):
            limiter.check("a", float(i))
        assert len(limiter._hits["a"]) <= 2


class TestClientKey:
    def _request(self, headers: dict[str, str], host: str = "10.0.0.1"):
        from starlette.requests import Request

        scope = {
            "type": "http",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
            "client": (host, 1234),
        }
        return Request(scope)

    def test_prefers_the_forwarded_client_over_the_proxy(self) -> None:
        """⚠️ Caddy fronts the API, so every request arrives from *its* address.
        Keying on `request.client.host` would put every user in one bucket and
        turn this defence into the denial of service it exists to prevent."""
        request = self._request({"x-forwarded-for": "203.0.113.7"}, host="172.18.0.5")
        assert client_key(request) == "203.0.113.7"

    def test_takes_the_left_most_entry(self) -> None:
        # Left-most is the original client; the rest are proxies it passed.
        request = self._request({"x-forwarded-for": "203.0.113.7, 172.18.0.5"})
        assert client_key(request) == "203.0.113.7"

    def test_falls_back_to_the_socket_when_unproxied(self) -> None:
        assert client_key(self._request({}, host="198.51.100.4")) == "198.51.100.4"


class TestMiddleware:
    def _app(self, limit: int = 2) -> TestClient:
        app = FastAPI()
        app.add_middleware(RateLimitMiddleware, limit=limit, window_seconds=60)

        @app.get("/thing")
        def thing() -> dict:
            return {"ok": True}

        @app.get("/health")
        def health() -> dict:
            return {"status": "ok"}

        return TestClient(app)

    def test_answers_429_with_a_retry_after(self) -> None:
        client = self._app(limit=2)
        headers = {"X-Forwarded-For": "203.0.113.1"}

        assert client.get("/thing", headers=headers).status_code == 200
        assert client.get("/thing", headers=headers).status_code == 200

        refused = client.get("/thing", headers=headers)
        assert refused.status_code == 429
        # Never 0: a client told to wait no time retries at once and is refused
        # again.
        assert int(refused.headers["Retry-After"]) >= 1

    def test_one_caller_does_not_refuse_another(self) -> None:
        client = self._app(limit=1)
        assert client.get("/thing", headers={"X-Forwarded-For": "203.0.113.1"}).status_code == 200
        assert client.get("/thing", headers={"X-Forwarded-For": "203.0.113.1"}).status_code == 429
        assert client.get("/thing", headers={"X-Forwarded-For": "203.0.113.2"}).status_code == 200

    def test_retry_after_is_never_zero_even_for_a_sub_second_wait(self) -> None:
        """⚠️ Added because a mutation survived.

        The original assertion used a 60 s window, so the rounding was never
        exercised: `int(60.0)` is comfortably >= 1 whether or not the code
        rounds up. A short window is what makes the difference visible — a
        client told to wait `0` retries immediately and is refused again, which
        is a busy loop rather than a limit.
        """
        app = FastAPI()
        app.add_middleware(RateLimitMiddleware, limit=1, window_seconds=0.5)

        @app.get("/thing")
        def thing() -> dict:
            return {"ok": True}

        client = TestClient(app)
        headers = {"X-Forwarded-For": "203.0.113.9"}
        assert client.get("/thing", headers=headers).status_code == 200

        refused = client.get("/thing", headers=headers)
        assert refused.status_code == 429
        assert int(refused.headers["Retry-After"]) >= 1

    def test_health_is_never_refused(self) -> None:
        """The container healthcheck and the deploy smoke test depend on it, so
        a flood must not make the stack look unhealthy and get it restarted."""
        assert "/health" in EXEMPT_PATHS
        client = self._app(limit=1)
        headers = {"X-Forwarded-For": "203.0.113.1"}

        for _ in range(5):
            assert client.get("/health", headers=headers).status_code == 200
