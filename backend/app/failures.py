"""Turning a yt-dlp failure into something a person can act on (#177).

`ImportJob.error` holds whatever yt-dlp said, which is written for someone
debugging a command line. What actually reached a user was this:

    ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. Use
    --cookies-from-browser or --cookies for the authentication. See
    https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp ...

A pilot tester can do nothing with that. It names a flag they cannot pass to a
server they do not administer.

## Why this is a derived code and not a stored column

The obvious shape is an `error_code` column written when the job fails. That
needs a migration on three tables — `import_jobs`, `playlist_imports` and
`track_matches` all carry an `error` — and it would freeze each row's
classification at the moment it was written, so improving the rules later would
not improve any row that already exists.

Classification is a pure function of the message, so it is computed when the row
is serialized instead. No migration, the raw text stays the single source of
truth, one implementation serves every path, and a better rule immediately
applies to every job ever recorded.

## Why not classify on the client

Two clients, and the app is bilingual. String-matching English yt-dlp output in
two codebases would drift, and the web client would disagree with the app about
what the same failure means. The backend names the *reason*; each client owns the
wording in each language.

Separate from `ytdlp._TRANSIENT_MARKERS`, which answers a different question —
whether retrying could help. A bot check is permanent *and* worth explaining; a
timeout is transient *and* worth explaining. The two classifications overlap
without either implying the other.
"""

from collections.abc import Sequence

# Ordered most specific first: several real messages match more than one rule.
# "Sign in to confirm your age" and "Sign in to confirm you're not a bot" share a
# prefix, and a 403 can arrive with a geo-restriction explanation attached.
_RULES: Sequence[tuple[str, tuple[str, ...]]] = (
    (
        "bot_check",
        ("not a bot", "confirm you're not a bot", "confirm you are not a bot"),
    ),
    ("age_restricted", ("confirm your age", "age-restricted", "age restricted")),
    ("private", ("private video", "is private", "login required")),
    ("removed", ("has been removed", "removed by the uploader", "account associated")),
    (
        "geo_restricted",
        ("in your country", "not available in your", "geo restriction", "geo-restricted"),
    ),
    ("unavailable", ("video unavailable", "no longer available", "this video is not available")),
    # 412 is Bilibili's anti-crawler answer, and it is **rate-based rather than
    # geo-based** — measured, see `ytdlp._TRANSIENT_MARKERS`. Without it here a
    # refused Bilibili add falls through to `unknown` ("The import failed"),
    # which is the raw-text problem #177 fixed for YouTube reappearing on the one
    # source that cannot be fetched on the device (#214, #320).
    ("rate_limited", ("429", "too many requests", "403", "412")),
    # Before `network`, which also matches "timed out": this is the task-level
    # ceiling (#213), and it means something different from a socket timeout.
    # A socket timeout is one read giving up and is often retried successfully;
    # this is the whole import being called hung and abandoned.
    ("took_too_long", ("timed out after", "took too long")),
    (
        "network",
        ("timed out", "timeout", "connection reset", "connection aborted", "connection refused"),
    ),
    ("unsupported", ("unsupported url", "is not a valid url", "no video formats")),
    ("drm", ("drm", "protected content")),
)

#: What a client shows when nothing matched. Named rather than `None` so the UI
#: always has a key to translate and never falls back to the raw text by
#: accident.
UNKNOWN = "unknown"


def classify_failure(message: str | None) -> str | None:
    """A stable code naming why an import failed, or `None` if it did not.

    `None` in means `None` out: a job with no error has no reason, and inventing
    "unknown" for a successful job would make every client check the status as
    well as the code.
    """
    if not message:
        return None

    haystack = message.lower()
    for code, markers in _RULES:
        if any(marker in haystack for marker in markers):
            return code
    return UNKNOWN
