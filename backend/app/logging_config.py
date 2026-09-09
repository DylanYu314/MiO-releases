"""Structured logging: one JSON object per line, with inherited context.

Two problems this solves, both created by moving work into worker processes
(ADR-006). First, prose log lines can't be queried — "why did that import
fail?" should be a filter, not a reading exercise. Second, a failure now
happens somewhere far from the request that caused it, so every line needs to
carry *which* job it belongs to.

The context part uses `contextvars`: bind `job_id` once at the top of a job
and every line logged underneath it carries that field, without passing a
logger (or the id) through every function.

Written on the standard library rather than pulling in a logging framework —
it is about sixty lines, and the mechanism is worth understanding.
"""

import json
import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

from app.config import get_settings

# None rather than {} as the default: a mutable default on a ContextVar is a
# classic footgun (every context would share the one object).
_context: ContextVar[dict[str, Any] | None] = ContextVar("log_context", default=None)


def _current_context() -> dict[str, Any]:
    return _context.get() or {}


# Everything the stdlib puts on a LogRecord. Anything *else* was passed by us
# via `extra=` and belongs in the JSON output.
_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__) | {
    "message",
    "asctime",
    "taskName",
}


@contextmanager
def log_context(**values: Any) -> Iterator[None]:
    """Attach fields to every log line emitted inside this block."""
    token = _context.set({**_current_context(), **values})
    try:
        yield
    finally:
        _context.reset(token)


class ContextFilter(logging.Filter):
    """Copies the current context onto each record on its way out."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key, value in _current_context().items():
            if not hasattr(record, key):
                setattr(record, key, value)
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        payload.update(
            {key: value for key, value in record.__dict__.items() if key not in _RESERVED}
        )
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class TextFormatter(logging.Formatter):
    """Human-readable equivalent, for watching a local run."""

    def format(self, record: logging.LogRecord) -> str:
        extras = " ".join(
            f"{key}={value}" for key, value in record.__dict__.items() if key not in _RESERVED
        )
        base = (
            f"{self.formatTime(record)} {record.levelname:<8} {record.name} {record.getMessage()}"
        )
        line = f"{base} {extras}" if extras else base
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        return line


def configure_logging() -> None:
    """Install the handler on the root logger. Safe to call more than once —
    both the API process and each Celery worker call it at startup."""
    settings = get_settings()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter() if settings.log_format == "json" else TextFormatter())
    handler.addFilter(ContextFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(settings.log_level.upper())

    # Our request middleware logs the same thing with more fields, so uvicorn's
    # plain-text access log would just be a noisy duplicate.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
