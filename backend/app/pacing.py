"""Adaptive, strictly-sequential download pacer (Enhancement Track B0).

Batch imports download one track at a time — SQLite tolerates a single writer,
so parallel downloads aren't on the table until Postgres in Phase 6. What we can
tune safely is the pause *between* downloads: it shrinks after each success (we
are evidently not being throttled, so speed up) and grows after a transient
failure (throttling/timeouts — back off), staying within a configured band.

Permanent failures (a private or removed video) leave the delay alone: they say
nothing about rate limits. A zero initial delay disables pacing entirely, which
is the escape hatch the test suite and local runs rely on.
"""

import time
from dataclasses import dataclass

from app.config import get_settings


def retry_backoff_seconds(attempt: int) -> int:
    """Exponential backoff for a transient download retry: 20s, 40s, 80s…
    Waiting longer each time is the point — an immediate retry hits the same
    throttling that just refused us. Shared by the Celery task layer (single
    jobs) and the inline batch retry loop, so both wait the same way."""
    return get_settings().download_retry_backoff_seconds * (2**attempt)


@dataclass
class AdaptivePacer:
    delay: float
    minimum: float
    maximum: float
    shrink: float
    grow: float
    enabled: bool = True

    @classmethod
    def from_settings(cls) -> "AdaptivePacer":
        s = get_settings()
        return cls(
            delay=s.download_pacing_seconds,
            minimum=s.download_pacing_min_seconds,
            maximum=s.download_pacing_max_seconds,
            shrink=s.download_pacing_shrink,
            grow=s.download_pacing_grow,
            # Determined once from the initial delay so mid-run adjustments can
            # never accidentally flip pacing on or off.
            enabled=s.download_pacing_seconds > 0,
        )

    def on_success(self) -> None:
        if self.enabled:
            self.delay = max(self.minimum, self.delay * self.shrink)

    def on_transient_failure(self) -> None:
        if self.enabled:
            self.delay = min(self.maximum, self.delay * self.grow)

    def wait(self) -> None:
        if self.enabled:
            time.sleep(self.delay)
