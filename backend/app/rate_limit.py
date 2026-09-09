"""An inbound request limit, so one caller cannot exhaust a self-hoster (#514).

## Why this exists, and who it protects

`app/pacing.py` is often mistaken for this and is the opposite: it paces
*outbound* downloads so YouTube is not hammered. Nothing limited *inbound*
requests at all, which #514 called "the obvious first thing to poke".

⚠️ **It protects a self-hoster, not me.** Since #608 MiO operates no
service, and the shipped app makes zero requests to any server (`serverUrl`
ships as `""`). The audience for this is somebody running
`docker-compose.prod.yml` themselves on an address the internet can reach.

Every expensive route is already gated by an access key (#614 closed the last
one), so this is not the primary guard — it is the one that still applies to
the routes anybody may call, and to a caller who simply sends a great many
requests.

## Why hand-rolled rather than `slowapi`

Same reasoning as `pacing.py`, which is also hand-rolled: the requirement is a
counter and a clock, the repo's convention is to add a dependency only when it
carries real weight, and `uv.lock` is the source of truth for every backend
version (#290) so a dependency is not free.

## ⚠️ The client address, and why `request.client.host` is wrong here

Caddy sits in front of the API (`docker-compose.prod.yml`), so *every* request
arrives from the proxy's address. Limiting on `request.client.host` would put
all users in one bucket: one noisy caller would lock out everybody, which is a
denial of service implemented as a defence against one.

`X-Forwarded-For`'s **left-most** entry is the original client. It is trusted
here because the only path to this app in production is through our own Caddy,
which overwrites it. ⚠️ Exposing the API directly, without a proxy, makes the
header attacker-controlled and this limit trivially evaded — `docs/self-hosting.md`
says to put it behind a reverse proxy for exactly this class of reason.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

# Paths that must answer even under load, because something operational depends
# on them: the container healthcheck and the deploy smoke test.
EXEMPT_PATHS = frozenset({"/health"})


def client_key(request: Request) -> str:
    """The caller's address, seen through the proxy."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # Left-most is the original client; the rest are proxies it passed.
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


class SlidingWindowLimiter:
    """Requests per window, per caller. Pure enough to test without a server.

    A sliding window rather than a fixed one: a fixed window lets a caller send
    the whole allowance at 59.9 s and again at 60.1 s, which is twice the limit
    across a second. The cost is keeping timestamps rather than a counter, and
    the deque is trimmed on every read so it cannot grow past the allowance.
    """

    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, now: float) -> float | None:
        """`None` if allowed, otherwise seconds until the caller may retry."""
        hits = self._hits[key]
        cutoff = now - self.window_seconds
        while hits and hits[0] <= cutoff:
            hits.popleft()

        if len(hits) >= self.limit:
            # The oldest hit is what has to age out for a slot to open.
            return max(0.0, hits[0] + self.window_seconds - now)

        hits.append(now)
        return None

    def forget(self, key: str) -> None:
        """Drop a caller's history. Exposed for tests, not used in the app."""
        self._hits.pop(key, None)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Reject a caller who is over the limit with **429** and `Retry-After`.

    ⚠️ **WebSockets never reach this.** `BaseHTTPMiddleware` handles the
    `http` scope only, so the progress sockets are untouched — deliberately,
    because a long-lived connection is not a request and counting it once would
    be meaningless while counting its frames would be wrong.
    """

    def __init__(self, app, limit: int, window_seconds: float = 60.0) -> None:
        super().__init__(app)
        self.limiter = SlidingWindowLimiter(limit, window_seconds)

    async def dispatch(self, request: Request, call_next):
        if request.url.path in EXEMPT_PATHS:
            return await call_next(request)

        retry_after = self.limiter.check(client_key(request), time.monotonic())
        if retry_after is not None:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests"},
                # Whole seconds, rounded up: a client told to wait 0 s retries
                # immediately and is refused again.
                headers={"Retry-After": str(max(1, int(retry_after) + 1))},
            )
        return await call_next(request)
