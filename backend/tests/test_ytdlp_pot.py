"""What the hosted backend attaches to get past YouTube's bot check.

Two mechanisms, both interim, both retired by #246 (the device downloads its own
audio): proof-of-origin tokens (#161) and an authenticated cookie file (#177).

What can be tested here is narrow, and worth being explicit about: that each
option reaches yt-dlp when configured, that it is absent when not, and that it
is applied to *every* call site rather than the one someone remembered.

What cannot be tested here is whether either one works. That is an
IP-reputation question — the same request succeeds from a home connection and
fails from a datacenter one — so it can only be answered by a real import from
the server. Measured 2026-07-31: 1/14 hosted, 14/14 from home. See
`docs/deployment.md`.
"""

import pytest

from app.config import get_settings
from app.ytdlp import _network_opts


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """`get_settings` is lru_cached, so a monkeypatched env var is invisible
    until the cache is dropped."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_no_provider_configured_leaves_the_options_untouched() -> None:
    """The default path is every local install and the whole test suite. If this
    ever starts adding an extractor arg, development starts reaching for a
    provider that isn't running."""
    opts = _network_opts()

    assert "extractor_args" not in opts
    assert opts == {"socket_timeout": 20, "retries": 3, "extractor_retries": 2}


def test_a_configured_provider_is_passed_to_ytdlp(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("YTDLP_POT_PROVIDER_URL", "http://pot-provider:4416")

    opts = _network_opts()

    assert opts["extractor_args"] == {
        "youtubepot-bgutilhttp": {"base_url": ["http://pot-provider:4416"]}
    }


def test_the_network_options_survive_alongside_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """socket_timeout is what stops a stalled extraction wedging an acks_late
    worker slot (ADR-006). Losing it to a merge would be invisible until a
    worker hung."""
    monkeypatch.setenv("YTDLP_POT_PROVIDER_URL", "http://pot-provider:4416")

    opts = _network_opts()

    assert opts["socket_timeout"] == 20
    assert opts["retries"] == 3
    assert opts["extractor_retries"] == 2


def test_an_empty_value_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """Compose writes an empty string when a variable is defined but blank, and
    an empty base_url would send the plugin at nothing at all."""
    monkeypatch.setenv("YTDLP_POT_PROVIDER_URL", "")

    assert "extractor_args" not in _network_opts()


def test_the_caller_cannot_mutate_the_shared_defaults() -> None:
    """The unconfigured path returns a copy. Handing out the module-level dict
    would let one call site's edit leak into every later one."""
    first = _network_opts()
    first["socket_timeout"] = 999

    assert _network_opts()["socket_timeout"] == 20


def test_every_extraction_path_sends_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """search, list_playlist and extract_and_download each build their own opts
    dict. A token that reaches only one of them fixes only one symptom — and
    downloading is the path that actually fails today."""
    monkeypatch.setenv("YTDLP_POT_PROVIDER_URL", "http://pot-provider:4416")

    import app.ytdlp as ytdlp

    captured: list[dict] = []

    class FakeYoutubeDL:
        def __init__(self, opts):
            captured.append(opts)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def extract_info(self, *_args, **_kwargs):
            return {"entries": [], "id": "x", "title": "t"}

    monkeypatch.setattr(ytdlp.yt_dlp, "YoutubeDL", FakeYoutubeDL)

    ytdlp.search("anything")
    with pytest.raises(ytdlp.ExtractionError):
        # Zero entries is a "not a playlist" failure; the opts were still built.
        ytdlp.list_playlist("https://example.com/playlist")

    assert len(captured) == 2
    for opts in captured:
        assert opts["extractor_args"] == {
            "youtubepot-bgutilhttp": {"base_url": ["http://pot-provider:4416"]}
        }


# --------------------------------------------------------------------------
# The cookie file (#177) — interim, retired by #246.
# --------------------------------------------------------------------------


def test_no_cookie_file_configured_adds_nothing() -> None:
    """Every local install. A home connection is not refused, so there is
    nothing here to solve and no credential to hand yt-dlp."""
    assert "cookiefile" not in _network_opts()


def test_a_configured_cookie_file_is_passed_to_ytdlp(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("YTDLP_COOKIES_FILE", "/app/secrets/cookies.txt")

    assert _network_opts()["cookiefile"] == "/app/secrets/cookies.txt"


def test_an_empty_cookie_path_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    """`YTDLP_COOKIES_FILE: ${MIO_COOKIES_FILE:+...}` writes an empty string on
    a deployment that has not configured one, and an empty `cookiefile` is a
    path to nothing rather than "no cookies"."""
    monkeypatch.setenv("YTDLP_COOKIES_FILE", "")

    assert "cookiefile" not in _network_opts()


def test_cookies_and_tokens_coexist(monkeypatch: pytest.MonkeyPatch) -> None:
    """They are not alternatives. The token attests the client is genuine, the
    cookies say which account it is, and the network options must survive both —
    an earlier version of this function returned early on the token branch and
    would have dropped the cookies entirely."""
    monkeypatch.setenv("YTDLP_POT_PROVIDER_URL", "http://pot-provider:4416")
    monkeypatch.setenv("YTDLP_COOKIES_FILE", "/app/secrets/cookies.txt")

    opts = _network_opts()

    assert opts["cookiefile"] == "/app/secrets/cookies.txt"
    assert opts["extractor_args"] == {
        "youtubepot-bgutilhttp": {"base_url": ["http://pot-provider:4416"]}
    }
    assert opts["socket_timeout"] == 20


def test_every_extraction_path_sends_the_cookies(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same reasoning as the token: downloading is the path that actually fails,
    and it builds its own opts dict."""
    monkeypatch.setenv("YTDLP_COOKIES_FILE", "/app/secrets/cookies.txt")

    import app.ytdlp as ytdlp

    captured: list[dict] = []

    class FakeYoutubeDL:
        def __init__(self, opts):
            captured.append(opts)

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def extract_info(self, *_args, **_kwargs):
            return {"entries": [], "id": "x", "title": "t"}

    monkeypatch.setattr(ytdlp.yt_dlp, "YoutubeDL", FakeYoutubeDL)

    ytdlp.search("anything")
    with pytest.raises(ytdlp.ExtractionError):
        ytdlp.list_playlist("https://example.com/playlist")

    assert len(captured) == 2
    for opts in captured:
        assert opts["cookiefile"] == "/app/secrets/cookies.txt"
