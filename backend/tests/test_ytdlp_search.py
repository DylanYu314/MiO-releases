import pytest
import yt_dlp

import app.ytdlp as ytdlp_module
from app.ytdlp import ExtractionError, TransientExtractionError, list_playlist, search


class FakeYoutubeDL:
    payload: dict | None = {}
    error: Exception | None = None
    last_url: str | None = None
    last_opts: dict = {}
    # What yt-dlp logs instead of raising when `ignoreerrors` is on.
    log_error: str | None = None

    def __init__(self, opts: dict) -> None:
        FakeYoutubeDL.last_opts = opts
        if FakeYoutubeDL.log_error is not None and opts.get("logger") is not None:
            opts["logger"].error(FakeYoutubeDL.log_error)

    def __enter__(self) -> "FakeYoutubeDL":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def extract_info(self, url: str, download: bool) -> dict | None:
        assert download is False
        FakeYoutubeDL.last_url = url
        if FakeYoutubeDL.error is not None:
            raise FakeYoutubeDL.error
        return FakeYoutubeDL.payload


@pytest.fixture(autouse=True)
def _fake_ydl(monkeypatch: pytest.MonkeyPatch) -> None:
    FakeYoutubeDL.payload = {"entries": []}
    FakeYoutubeDL.error = None
    FakeYoutubeDL.log_error = None
    monkeypatch.setattr(ytdlp_module.yt_dlp, "YoutubeDL", FakeYoutubeDL)


def test_search_builds_a_flat_ytsearch_query() -> None:
    search("rick astley never gonna", limit=5)

    assert FakeYoutubeDL.last_url == "ytsearch5:rick astley never gonna"
    assert FakeYoutubeDL.last_opts["extract_flat"] == "in_playlist"
    assert FakeYoutubeDL.last_opts["skip_download"] is True


def test_search_uses_the_bilibili_prefix() -> None:
    search("some song", limit=3, platform="bilibili")

    assert FakeYoutubeDL.last_url == "bilisearch3:some song"


def test_search_rejects_an_unknown_platform() -> None:
    with pytest.raises(ValueError, match="Unsupported search platform"):
        search("query", platform="soundcloud")


def test_extractions_set_a_socket_timeout() -> None:
    """Without it a stalled connection hangs a worker slot forever (ADR-006
    tasks ack late), which is how a big playlist listing wedged the worker."""
    search("anything")
    assert FakeYoutubeDL.last_opts["socket_timeout"] == 20

    FakeYoutubeDL.payload = {"title": "P", "entries": [{"url": "https://y/1", "title": "One"}]}
    list_playlist("https://youtube.com/playlist?list=X")
    assert FakeYoutubeDL.last_opts["socket_timeout"] == 20


def test_search_maps_entries_and_fills_gaps() -> None:
    FakeYoutubeDL.payload = {
        "entries": [
            {
                "url": "https://www.youtube.com/watch?v=abc",
                "title": "Full Entry",
                "uploader": "Uploader",
                "duration": 212.0,
            },
            # No direct url — built from the id; uploader falls back to channel.
            {"id": "xyz", "title": "Id Only", "channel": "Channel Name"},
            # Unusable entries are skipped, not crashed on.
            {"id": "notitle"},
            None,
        ]
    }

    results = search("query")

    assert [result.title for result in results] == ["Full Entry", "Id Only"]
    assert results[0].uploader == "Uploader"
    assert results[0].duration == 212.0
    assert results[1].url == "https://www.youtube.com/watch?v=xyz"
    assert results[1].uploader == "Channel Name"
    assert results[1].duration is None


def test_search_wraps_download_errors() -> None:
    FakeYoutubeDL.error = yt_dlp.utils.DownloadError("search blocked")

    with pytest.raises(ExtractionError, match="search blocked"):
        search("query")


TRANSIENT_MESSAGES = [
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "HTTP Error 429: Too Many Requests",
    "ERROR: [youtube] read error: The read operation timed out",
    "HTTP Error 503: Service Unavailable",
    "Connection reset by peer",
]

PERMANENT_MESSAGES = [
    "ERROR: [youtube] abc: Video unavailable",
    "ERROR: [youtube] abc: Private video. Sign in if you've been granted access",
    "ERROR: [youtube] abc: Sign in to confirm your age",
    "ERROR: [youtube] abc: This video is not available in your country",
]


def test_list_playlist_maps_title_and_entries() -> None:
    FakeYoutubeDL.payload = {
        "title": "Road Trip",
        "entries": [
            {"url": "https://y/1", "title": "One", "uploader": "A", "duration": 100.0},
            # No direct url — built from the id; uploader falls back to channel.
            {"id": "vid2", "title": "Two", "channel": "B"},
            {"id": "notitle"},  # skipped
            None,
        ],
    }

    listing = list_playlist("https://youtube.com/playlist?list=X")

    assert listing.title == "Road Trip"
    assert [entry.title for entry in listing.entries] == ["One", "Two"]
    assert listing.entries[1].url == "https://www.youtube.com/watch?v=vid2"
    assert listing.entries[1].uploader == "B"


def test_list_playlist_counts_what_it_dropped() -> None:
    """The playlist's size, not the number of entries that survived (#585).

    A deleted, private or region-blocked video comes back from flat extraction
    with no title, and the loop skips it. That skipping was silent, so
    ``_fetch_youtube_playlist`` recorded the survivors as the import's own
    ``track_count`` — an eighteen-track playlist became a four-track import and
    the phone honestly reported "4/4 done" about an already-wrong number.
    """
    FakeYoutubeDL.payload = {
        "title": "Road Trip",
        "playlist_count": 4,
        "entries": [
            {"url": "https://y/1", "title": "One", "uploader": "A", "duration": 100.0},
            {"id": "notitle"},  # a deleted video looks exactly like this
            None,  # and so does a private one, sometimes
            {"title": "No url and no id"},  # dropped by the second guard
        ],
    }

    listing = list_playlist("https://youtube.com/playlist?list=X")

    assert len(listing.entries) == 1
    assert listing.announced_count == 4
    assert listing.skipped == 3


def test_list_playlist_falls_back_to_the_raw_entry_count() -> None:
    """Not every extractor sets ``playlist_count``.

    ⚠️ Falling back to ``len(raw_entries)`` and **not** to ``len(entries)``.
    The whole point of the number is to be able to disagree with what we kept;
    seeding it from what we kept would make it agree by construction, and the
    check could then only ever pass.
    """
    FakeYoutubeDL.payload = {
        "title": "Road Trip",
        "entries": [
            {"url": "https://y/1", "title": "One", "uploader": "A", "duration": 100.0},
            {"id": "notitle"},
        ],
    }

    listing = list_playlist("https://youtube.com/playlist?list=X")

    assert listing.announced_count == 2
    assert listing.skipped == 1


def test_list_playlist_without_entries_is_an_error() -> None:
    FakeYoutubeDL.payload = {"title": "A single video"}  # no entries

    with pytest.raises(ExtractionError, match="doesn't look like a playlist"):
        list_playlist("https://youtu.be/one-video")


@pytest.mark.parametrize("message", TRANSIENT_MESSAGES)
def test_throttling_and_timeouts_are_transient(message: str) -> None:
    """These are worth retrying — the 403 is how YouTube throttles a client
    that has downloaded many files in a row."""
    FakeYoutubeDL.error = yt_dlp.utils.DownloadError(message)

    with pytest.raises(TransientExtractionError):
        search("query")


@pytest.mark.parametrize("message", PERMANENT_MESSAGES)
def test_unavailable_videos_are_permanent(message: str) -> None:
    """Retrying these would waste attempts on something that cannot succeed."""
    FakeYoutubeDL.error = yt_dlp.utils.DownloadError(message)

    with pytest.raises(ExtractionError) as exc_info:
        search("query")
    assert not isinstance(exc_info.value, TransientExtractionError)


def test_bilibili_search_does_not_use_flat_extraction() -> None:
    """The bug in #99: flat Bilibili entries are a URL and nothing else.

    Every result was dropped by the title filter, so the search bar returned
    nothing at all — no error, just an empty list.
    """
    search("稻香", limit=3, platform="bilibili")

    assert FakeYoutubeDL.last_url == "bilisearch3:稻香"
    assert FakeYoutubeDL.last_opts["extract_flat"] is False


def test_youtube_keeps_flat_extraction() -> None:
    # One request for a whole page of results; YouTube's flat entries carry
    # everything the matcher needs.
    search("anything", limit=5, platform="youtube")

    assert FakeYoutubeDL.last_opts["extract_flat"] == "in_playlist"


def test_bilibili_results_are_capped_because_each_costs_a_request() -> None:
    search("稻香", limit=50, platform="bilibili")

    assert FakeYoutubeDL.last_url == "bilisearch3:稻香"


def test_youtube_has_a_higher_ceiling() -> None:
    search("anything", limit=50, platform="youtube")

    assert FakeYoutubeDL.last_url == "ytsearch20:anything"


def test_a_limit_of_zero_still_asks_for_one() -> None:
    search("anything", limit=0)

    assert FakeYoutubeDL.last_url == "ytsearch1:anything"


def test_bilibili_results_carry_full_metadata() -> None:
    # What full extraction returns, unlike the URL-only flat entries.
    FakeYoutubeDL.payload = {
        "entries": [
            {
                "id": "BV1xx",
                "title": "【私藏馆】周杰伦《稻香》",
                "uploader": "音乐私藏馆",
                "duration": 222.506,
                "webpage_url": "https://www.bilibili.com/video/BV1xx",
                "url": "https://cdn.example.com/media.m4s",
            }
        ]
    }

    results = search("稻香", platform="bilibili")

    assert len(results) == 1
    assert results[0].title == "【私藏馆】周杰伦《稻香》"
    assert results[0].uploader == "音乐私藏馆"
    assert results[0].duration == 222.506
    # The page, not the media stream: a media URL cannot be re-downloaded later.
    assert results[0].url == "https://www.bilibili.com/video/BV1xx"


def test_one_unusable_entry_does_not_lose_the_others() -> None:
    """#124: non-flat extraction hits every entry, and yt-dlp aborts the whole
    search when one fails. A deleted or geo-restricted video used to take every
    other result down with it and answer 502."""
    FakeYoutubeDL.payload = {
        "entries": [
            None,  # what ignoreerrors leaves behind for a failed entry
            {
                "id": "BV1ok",
                "title": "K-ON! Don't say lazy",
                "uploader": "someone",
                "duration": 240.0,
                "webpage_url": "https://www.bilibili.com/video/BV1ok",
            },
            None,
        ]
    }

    results = search("K-on", platform="bilibili")

    assert [r.title for r in results] == ["K-ON! Don't say lazy"]


def test_search_skips_unusable_entries_rather_than_aborting() -> None:
    search("anything", platform="bilibili")

    assert FakeYoutubeDL.last_opts["ignoreerrors"] is True


def test_a_refusal_carrying_a_placeholder_entry_is_still_an_error() -> None:
    """The trap in `ignoreerrors`, in the shape Bilibili actually produces.

    A refused search does not come back empty — measured live, it answers in
    ~0.4s with a *single placeholder entry* that the mapping loop then skips.
    Judging by the raw entry count therefore misses it, and the 412 surfaces as
    "no results": a temporary refusal made to look like a permanent absence,
    with a retry made to look pointless.
    """
    FakeYoutubeDL.payload = {"entries": [None]}
    FakeYoutubeDL.log_error = "ERROR: K-on: Unable to download JSON metadata: HTTP Error 412"

    with pytest.raises(TransientExtractionError, match="412"):
        search("K-on", platform="bilibili")


def test_a_refusal_that_yields_no_entries_is_still_an_error() -> None:
    FakeYoutubeDL.payload = {"entries": []}
    FakeYoutubeDL.log_error = "ERROR: Unable to download JSON metadata: HTTP Error 412"

    with pytest.raises(TransientExtractionError, match="412"):
        search("稻香", platform="bilibili")


def test_every_entry_unusable_reports_why_rather_than_no_results() -> None:
    """All results geo-restricted is a real outcome, but it is not "nothing
    matched" — the reason is worth surfacing instead of an empty list."""
    FakeYoutubeDL.payload = {"entries": [None, None]}
    FakeYoutubeDL.log_error = "ERROR: [BiliBili] 1163: This video may be deleted or geo-restricted"

    with pytest.raises(ExtractionError, match="geo-restricted"):
        search("K-on", platform="bilibili")


def test_a_swallowed_top_level_failure_is_still_an_error() -> None:
    """The same failure in its other observed shape: None instead of a dict."""
    FakeYoutubeDL.payload = None
    FakeYoutubeDL.log_error = "ERROR: Unable to download JSON metadata: HTTP Error 412"

    with pytest.raises(TransientExtractionError, match="412"):
        search("稻香", platform="bilibili")


def test_a_swallowed_failure_with_no_message_is_still_raised() -> None:
    FakeYoutubeDL.payload = None

    with pytest.raises(ExtractionError, match="Search failed"):
        search("稻香", platform="bilibili")


def test_a_genuinely_empty_search_is_not_an_error() -> None:
    """No entries and nothing logged means the query really has no results —
    distinct from a refusal, and not something to raise about."""
    FakeYoutubeDL.payload = {"entries": []}

    assert search("no such song anywhere", platform="bilibili") == []


def test_a_per_entry_error_does_not_fail_a_partly_good_search() -> None:
    """An error logged alongside usable entries is one `ignoreerrors` already
    dealt with — it must not turn a partial success into a failure."""
    FakeYoutubeDL.payload = {
        "entries": [None, {"id": "BV1ok", "title": "K-ON!", "webpage_url": "https://b/v/1"}]
    }
    FakeYoutubeDL.log_error = "ERROR: [BiliBili] 1163: This video may be deleted or geo-restricted"

    assert [r.title for r in search("K-on", platform="bilibili")] == ["K-ON!"]


def test_bilibili_rate_limiting_is_transient() -> None:
    """Bilibili answers 412 when it thinks you are a crawler.

    Measured to be rate-based, not request-shaped: the identical call succeeds
    a minute later. Classifying it as permanent would abandon work that would
    have succeeded on a retry.
    """
    FakeYoutubeDL.error = yt_dlp.utils.DownloadError(
        "ERROR: 稻香: Unable to download JSON metadata: HTTP Error 412: Precondition Failed"
    )

    with pytest.raises(TransientExtractionError):
        search("稻香", platform="bilibili")
