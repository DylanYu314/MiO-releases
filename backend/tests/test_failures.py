"""Classifying yt-dlp failures into codes a client can translate (#177)."""

import pytest

from app.failures import UNKNOWN, classify_failure
from app.schemas import JobRead


def test_no_error_has_no_reason():
    # None in, None out. A successful job must not carry a reason, or every
    # client would have to check the status as well as the code.
    assert classify_failure(None) is None
    assert classify_failure("") is None


def test_the_message_that_prompted_this():
    # Verbatim from a real failed import against the production server on
    # 2026-07-30, which is what #177 was filed about.
    raw = (
        "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. "
        "Use --cookies-from-browser or --cookies for the authentication. See "
        "https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp "
        "for how to manually pass cookies."
    )
    assert classify_failure(raw) == "bot_check"


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("Sign in to confirm you're not a bot", "bot_check"),
        ("Sign in to confirm your age", "age_restricted"),
        ("Private video. Sign in if you've been granted access", "private"),
        ("This video has been removed by the uploader", "removed"),
        ("The uploader has not made this video available in your country", "geo_restricted"),
        ("Video unavailable", "unavailable"),
        ("HTTP Error 429: Too Many Requests", "rate_limited"),
        ("HTTP Error 403: Forbidden", "rate_limited"),
        # Bilibili's anti-crawler answer, and the one source a device cannot
        # fetch for itself (#320) — so it is the one that still reaches this
        # classifier in practice. Without the rule it lands in `unknown`, which
        # is "The import failed" and tells a tester nothing (#214).
        ("HTTP Error 412: Precondition Failed", "rate_limited"),
        ("Read timed out", "network"),
        ("Unsupported URL: https://example.com/nope", "unsupported"),
        ("Something nobody has seen before", UNKNOWN),
    ],
)
def test_known_failures(message, expected):
    assert classify_failure(message) == expected


def test_age_and_bot_checks_are_told_apart():
    # Both begin "Sign in to confirm", and telling a user to verify their age
    # when the server was flagged as a bot sends them somewhere useless. Rule
    # order is what keeps these apart, so it is worth pinning.
    assert classify_failure("Sign in to confirm you're not a bot") == "bot_check"
    assert classify_failure("Sign in to confirm your age") == "age_restricted"


def test_classification_is_case_insensitive():
    assert classify_failure("VIDEO UNAVAILABLE") == "unavailable"
    assert classify_failure("private VIDEO") == "private"


def test_job_read_exposes_the_code():
    """The point of deriving rather than storing: the code comes from the text.

    A row written long before this feature existed gets classified the moment it
    is serialized, with no migration and no backfill.
    """
    job = JobRead(
        id=1,
        source_url="https://youtube.com/watch?v=x",
        status="failed",
        progress=None,
        song_id=None,
        error="ERROR: [youtube] x: Video unavailable",
        created_at="2026-07-30T00:00:00",
        updated_at="2026-07-30T00:00:00",
    )
    assert job.error_code == "unavailable"

    dumped = job.model_dump()
    # Serialized, not just a Python property — the clients read JSON.
    assert dumped["error_code"] == "unavailable"
    # The raw text survives alongside it. It is what the code is derived from,
    # and what anyone debugging actually needs.
    assert "Video unavailable" in dumped["error"]


def test_a_successful_job_serializes_a_null_code():
    job = JobRead(
        id=2,
        source_url="https://youtube.com/watch?v=y",
        status="done",
        progress=100,
        song_id=5,
        error=None,
        created_at="2026-07-30T00:00:00",
        updated_at="2026-07-30T00:00:00",
    )
    assert job.model_dump()["error_code"] is None
