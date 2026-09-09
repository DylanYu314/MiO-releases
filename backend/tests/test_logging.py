import json
import logging
import sys

import pytest
from fastapi.testclient import TestClient

from app.logging_config import ContextFilter, JsonFormatter, TextFormatter, log_context


def make_record(message: str = "hello", **extra: object) -> logging.LogRecord:
    record = logging.LogRecord(
        name="app.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=(),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    ContextFilter().filter(record)
    return record


def test_json_output_is_one_parseable_object() -> None:
    line = JsonFormatter().format(make_record("job status", job_id=7, status="downloading"))

    payload = json.loads(line)
    assert payload["message"] == "job status"
    assert payload["level"] == "info"
    assert payload["logger"] == "app.test"
    assert payload["job_id"] == 7
    assert payload["status"] == "downloading"
    assert "ts" in payload


def test_stdlib_record_internals_stay_out_of_the_payload() -> None:
    """Otherwise every line carries pathname, lineno, thread ids and friends."""
    payload = json.loads(JsonFormatter().format(make_record()))

    assert set(payload) == {"ts", "level", "logger", "message"}


def test_context_is_attached_to_records_inside_the_block() -> None:
    with log_context(job_id=42):
        inside = json.loads(JsonFormatter().format(make_record("working")))
    outside = json.loads(JsonFormatter().format(make_record("done")))

    assert inside["job_id"] == 42
    assert "job_id" not in outside


def test_nested_context_merges_and_unwinds() -> None:
    with log_context(playlist_import_id=1):
        with log_context(track="Never Gonna Give You Up"):
            both = json.loads(JsonFormatter().format(make_record()))
        after = json.loads(JsonFormatter().format(make_record()))

    assert both["playlist_import_id"] == 1
    assert both["track"] == "Never Gonna Give You Up"
    assert after["playlist_import_id"] == 1
    assert "track" not in after


def test_explicit_fields_win_over_context() -> None:
    with log_context(job_id=1):
        payload = json.loads(JsonFormatter().format(make_record(job_id=2)))

    assert payload["job_id"] == 2


def test_exceptions_are_included() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        record = logging.LogRecord(
            name="app.test",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="job failed",
            args=(),
            exc_info=sys.exc_info(),
        )

    payload = json.loads(JsonFormatter().format(record))

    assert "ValueError: boom" in payload["exception"]


def test_text_format_stays_readable() -> None:
    line = TextFormatter().format(make_record("job status", job_id=7))

    assert "job status" in line
    assert "job_id=7" in line


def test_requests_are_logged_with_status_and_duration(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="app.main"):
        client.get("/health")

    request_logs = [r for r in caplog.records if r.message == "request"]
    assert len(request_logs) == 1
    assert request_logs[0].method == "GET"
    assert request_logs[0].path == "/health"
    assert request_logs[0].status == 200
    assert request_logs[0].duration_ms >= 0


def test_each_request_gets_its_own_id(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="app.main"):
        client.get("/health")
        client.get("/health")

    ids = [r.request_id for r in caplog.records if r.message == "request"]
    assert len(ids) == 2
    assert ids[0] != ids[1]
