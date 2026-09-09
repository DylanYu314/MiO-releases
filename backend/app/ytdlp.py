import re
from dataclasses import dataclass
from pathlib import Path

import yt_dlp

from app.config import get_settings


class ExtractionError(Exception):
    """Raised when yt-dlp can't extract/download a URL (bad URL, geo-block, age-gate, ...)."""


class TransientExtractionError(ExtractionError):
    """A failure worth retrying: throttling, a timeout, a server-side error.

    Distinguished from a permanent one (private, removed, geo-blocked) because
    retrying those would just waste attempts on something that cannot succeed.
    """


# Substrings that mark a yt-dlp failure as temporary. 403 is here because
# that is how YouTube throttles a client making many requests in a row — the
# exact failure that lost 11 tracks in the first large playlist import.
_TRANSIENT_MARKERS = (
    "403",
    # Bilibili's anti-crawler answer. Measured to be rate-based rather than
    # mode-based: the same request succeeds moments later, and probing three
    # extraction modes back-to-back makes whichever ran first look "broken".
    "412",
    "429",
    "too many requests",
    "timed out",
    "timeout",
    "temporarily",
    "try again",
    "connection reset",
    "connection aborted",
    "connection refused",
    "http error 5",  # 500, 502, 503, 504...
    "read error",
    "unable to download video data",
    "giving up after",
)


def _extraction_error(exc: Exception) -> ExtractionError:
    """Wrap a yt-dlp failure, classifying it as transient or permanent."""
    message = str(exc)
    if any(marker in message.lower() for marker in _TRANSIENT_MARKERS):
        return TransientExtractionError(message)
    return ExtractionError(message)


# A stalled connection must fail, not hang: tasks ack late (ADR-006), so an
# unfinished extraction never frees its worker slot — one hung call (e.g. a big
# playlist listing that YouTube slow-walks) can wedge the whole worker and leave
# every later import stuck at `queued`. socket_timeout bounds each read; the
# retries turn a timeout into a bounded number of attempts, not an endless loop.
_NETWORK_OPTS = {
    "socket_timeout": 20,
    "retries": 3,
    "extractor_retries": 2,
}


def _network_opts() -> dict:
    """The shared network options, plus whatever the host needs to be let in.

    YouTube refuses datacenter IPs outright — "Sign in to confirm you're not a
    bot", on the very first request, before any pacing could matter. It is not
    rate limiting and `AdaptivePacer` cannot help: the address is the problem,
    not the behaviour. The same URL imports fine from a home connection, which
    is why this never appeared until the backend was hosted (#161).

    Two things are attached here, and neither is a fix.

    **A proof-of-origin token** is what a real client sends to attest it is
    genuine. yt-dlp cannot mint one itself, so a provider service does it and
    yt-dlp's plugin fetches from there. `POT_PROVIDER_URL` points at it.

    **A cookie file** borrows a signed-in account's identity, which is the only
    remaining way to make a datacenter address look like a person. It became
    usable only with #245: without a JS runtime, extraction fell back to the
    `android_vr` client, and that client does not send cookies at all
    (`SUPPORTS_COOKIES` is False on it, True on `web`). So a cookie file added
    before #245 would have been read and then ignored.

    Measured 2026-07-31, three batches of the same 14 URLs against the hosted
    server: **1/14**, unchanged by #245, against 14/14 from a home connection.

    ⚠️ **Both are interim.** #246 is the plan that retires them — the device
    downloads its own audio, so the request comes from a residential address and
    there is nothing to attest to. Do not build further server-side evasion on
    top of this; it is a stopgap with a known replacement.

    Unset — every local install, and the whole test suite — this returns exactly
    what it always did, so nothing about development changes.
    """
    settings = get_settings()
    opts = dict(_NETWORK_OPTS)

    if settings.ytdlp_pot_provider_url:
        # The plugin reads its own extractor-args namespace. Values are lists,
        # which is how yt-dlp represents repeated extractor arguments.
        opts["extractor_args"] = {
            "youtubepot-bgutilhttp": {"base_url": [settings.ytdlp_pot_provider_url]}
        }

    # Deliberately not checked for existence here. yt-dlp raises a clear error
    # naming the path, which is a better failure than silently extracting
    # without the cookies and reporting a bot check — the symptom we would then
    # spend a session diagnosing for the second time.
    if settings.ytdlp_cookies_file:
        opts["cookiefile"] = settings.ytdlp_cookies_file

    return opts


@dataclass
class SearchResult:
    url: str
    title: str
    uploader: str | None
    duration: float | None
    thumbnail: str | None = None
    # Which platform produced this candidate (#551). Defaulted to YouTube
    # because that is what every caller predating the Bilibili source sends,
    # and because a missing source must never silently earn the Topic bonus —
    # see `_is_topic_channel` in matching.py.
    source: str = "youtube"


# The widest thumbnail worth sending to a phone. A review row is a 44-point
# square; anything past this is bytes nobody sees.
_MAX_THUMBNAIL_WIDTH = 640


def _thumbnail_of(entry: dict) -> str | None:
    """The best available thumbnail URL for a search or listing entry (#312).

    Read off the **flat** extraction, which already carries it — checked against
    a live search on 2026-08-05 rather than assumed. Note that `entry["thumbnail"]`
    is `None` there and `entry["thumbnails"]` is the populated one; reaching for
    the singular is the obvious mistake and yields nothing.

    These URLs are public and signed by YouTube, so the device fetches them
    directly with none of our headers — the same reason `artworkUrlFor` needed a
    `file://` path for owned covers (#218) does not apply here.
    """
    thumbnails = entry.get("thumbnails") or []
    usable = [
        thumbnail
        for thumbnail in thumbnails
        if isinstance(thumbnail, dict) and thumbnail.get("url")
    ]
    if not usable:
        return None

    def width(thumbnail: dict) -> int:
        value = thumbnail.get("width")
        return value if isinstance(value, int) else 0

    # The widest that is not extravagant, and failing that the narrowest there
    # is — a thumbnail of unknown size beats no thumbnail.
    within = [thumbnail for thumbnail in usable if width(thumbnail) <= _MAX_THUMBNAIL_WIDTH]
    if within:
        return max(within, key=width)["url"]
    return min(usable, key=width)["url"]


_TOPIC_CHANNEL = re.compile(r"\s*-\s*topic\s*$", re.IGNORECASE)

# Auto-generated channel names that name no artist at all.
#
# YouTube files an upload with no distinct artist channel under a generic
# bucket, and "Release - Topic" is the one this project has actually met:
# measured 2026-08-05 against several unrelated tracks by different artists
# (稻香 by 周冠喆 among them), all uploaded by the same "Release - Topic".
# Stripping the suffix leaves "Release", which is not a person and reads as a
# bug — it is what #307 was reported as.
#
# Listed from observation rather than imagination: other buckets very likely
# exist, and the way to find them is to meet one.
_ANONYMOUS_CHANNELS = {"release"}


def display_artist(uploader: str | None) -> str | None:
    """The artist to *show*, from a channel name, or None if it names nobody.

    Auto-generated YouTube "Topic" channels are the whole problem here. Their
    uploader is `"<Artist> - Topic"`, so the suffix has to come off — and when
    what is left is one of YouTube's generic buckets, there was never an artist
    in the string to begin with and the caller should say so plainly rather
    than print it.

    **Not `matching.normalize()`**, which the issue suggested and which would be
    wrong: that one casefolds, strips diacritics and removes punctuation to make
    two strings *comparable*. Run over a title it returns "bohemian rhapsody".
    A comparison key is not a display string. `matching._is_topic_channel` stays
    where it is too — it answers a scoring question, and merging the two would
    put the matcher's behaviour at risk of a display change.

    The real artist does exist, but only in a **full** extraction: a Topic
    upload carries `artist`, `track` and `album` fields, which the flat listing
    a playlist import uses does not fetch. `extract_and_download` below prefers
    them for exactly that reason.
    """
    if uploader is None:
        return None
    name = _TOPIC_CHANNEL.sub("", uploader).strip()
    if not name or name.casefold() in _ANONYMOUS_CHANNELS:
        return None
    return name


# yt-dlp's search-URL prefixes per platform. Bilibili is experimental — yt-dlp's
# coverage of it is uneven (see docs/future-plans.md).
SEARCH_PREFIXES = {"youtube": "ytsearch", "bilibili": "bilisearch"}

# Extraction differs per platform, and it is not a tuning preference.
#
# YouTube's flat listing carries title, uploader and duration, so one request
# serves a whole page of results.
#
# Bilibili's does not: flat entries are a URL and nothing else, so every result
# was dropped by the title filter below and the search bar silently returned
# nothing (#99). It needs full extraction — one request per result, which is
# why its default limit is lower. `extract_flat: True` is not a middle ground;
# it also yields title-less entries.
_SEARCH_FLAT_EXTRACTION = {"youtube": "in_playlist", "bilibili": False}

# Per-request cost differs by the same factor, so the ceilings do too. Every
# extra Bilibili result is another request against a source that answers
# slowly and unevenly — five results measured anywhere from 18.6s to 117.5s —
# so the result count is the only part of that cost we control.
_SEARCH_MAX_RESULTS = {"youtube": 20, "bilibili": 3}


class _ErrorCapturingLogger:
    """Keeps the last error yt-dlp reports, so a swallowed failure can still be
    classified.

    With `ignoreerrors` on, yt-dlp *logs* failures instead of raising them —
    including the top-level one, where it then returns None. Without the
    message there would be no way to tell a rate-limit refusal from a query
    that genuinely has no results.
    """

    def __init__(self) -> None:
        self.last_error: str | None = None

    def debug(self, message: str) -> None: ...

    def info(self, message: str) -> None: ...

    def warning(self, message: str) -> None: ...

    def error(self, message: str) -> None:
        self.last_error = message


def search(query: str, limit: int = 5, platform: str = "youtube") -> list[SearchResult]:
    """Top results for a query on `platform`, without downloading anything.

    YouTube uses flat extraction — one metadata request for the whole result
    page rather than one per video, which is all the matcher (and the search
    bar) needs. Bilibili cannot: see `_SEARCH_FLAT_EXTRACTION`. Defaults to
    YouTube so the matcher's callers are unaffected.

    Entries that fail to extract are skipped rather than failing the search
    (#124): under non-flat extraction one deleted or geo-restricted video would
    otherwise abort every other result alongside it.
    """
    prefix = SEARCH_PREFIXES.get(platform)
    if prefix is None:
        raise ValueError(f"Unsupported search platform: {platform}")

    # A caller asking for more than the platform can serve cheaply gets the
    # platform's ceiling, not a request that takes half a minute.
    limit = max(1, min(limit, _SEARCH_MAX_RESULTS.get(platform, 20)))

    logger = _ErrorCapturingLogger()
    ydl_opts = {
        **_network_opts(),
        "quiet": True,
        "no_warnings": True,
        "extract_flat": _SEARCH_FLAT_EXTRACTION.get(platform, "in_playlist"),
        "skip_download": True,
        # Skip an unusable entry instead of aborting the whole search (#124).
        "ignoreerrors": True,
        "logger": logger,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"{prefix}{limit}:{query}", download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise _extraction_error(exc) from exc

    results = []
    for entry in (info or {}).get("entries") or []:
        if not entry or not entry.get("title"):
            continue
        # Full extraction reports the canonical page as `webpage_url`; a flat
        # entry only has `url`. Preferring webpage_url keeps Bilibili results
        # pointing at a page yt-dlp can download later, not a media URL.
        url = (
            entry.get("webpage_url")
            or entry.get("url")
            or (f"https://www.youtube.com/watch?v={entry['id']}" if entry.get("id") else None)
        )
        if not url:
            continue
        results.append(
            SearchResult(
                url=url,
                title=entry["title"],
                uploader=entry.get("uploader") or entry.get("channel"),
                duration=entry.get("duration"),
                thumbnail=_thumbnail_of(entry),
            )
        )

    # `ignoreerrors` downgrades a failure to a log line, so a refused search
    # still returns "successfully" — measured live as a 0.4s answer carrying a
    # single placeholder entry, which the loop above then skips. Judging that by
    # the raw entry count is not enough: what matters is that nothing usable came
    # back while an error was logged. Reported as an empty list, a 412 would read
    # as "no results found" — the one reading that must never happen, since it
    # makes a temporary refusal look like a permanent absence and a retry look
    # pointless. An error logged *alongside* usable results is a per-entry
    # failure `ignoreerrors` already handled, so only an empty result set
    # consults it.
    if not results and logger.last_error:
        raise _extraction_error(RuntimeError(logger.last_error))
    if info is None:
        raise _extraction_error(RuntimeError("Search failed"))
    return results


@dataclass
class PlaylistEntry:
    url: str
    title: str
    uploader: str | None
    duration: float | None
    thumbnail: str | None = None


@dataclass
class PlaylistListing:
    title: str | None
    entries: list[PlaylistEntry]
    #: How many entries the playlist claims to have, before anything was
    #: skipped (#585).
    #:
    #: ``entries`` is what survived: a deleted, private or region-blocked video
    #: comes back from flat extraction with no title, and the loop below drops
    #: it. Recording only the survivors made the import's own ``track_count``
    #: become "the ones we could read", so an eighteen-track playlist reported
    #: four tracks and the phone honestly said "4/4 done" about a number that
    #: was already wrong.
    #:
    #: ⚠️ **Every other playlist source in MiO already guards this.** NetEase,
    #: QQ Music and Kugou compare the service's own stated count with the rows
    #: returned (ADR-013). The one source without the guard was the one whose
    #: listing runs here — on the address #177 measured YouTube refusing 13
    #: requests in 14, and therefore the one most likely to come back short.
    announced_count: int
    #: Entries the extractor returned and this could not use. ``announced_count
    #: - len(entries)`` is not the same thing: a playlist can announce more than
    #: it hands over, which is a different fault and worth telling apart.
    skipped: int


def list_playlist(url: str) -> PlaylistListing:
    """List a public playlist's videos without downloading anything.

    Flat extraction: one metadata request for the whole playlist. Raises
    ExtractionError if the URL resolves to no entries (e.g. a single video),
    which the caller turns into a helpful failure.
    """
    ydl_opts = {
        **_network_opts(),
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise _extraction_error(exc) from exc

    raw_entries = (info or {}).get("entries")
    if not raw_entries:
        raise ExtractionError("That URL doesn't look like a playlist")

    entries = []
    skipped = 0
    for entry in raw_entries:
        # Counted rather than merely skipped (#585). This is where a deleted or
        # private video goes, and it used to go silently.
        if not entry or not entry.get("title"):
            skipped += 1
            continue
        entry_url = entry.get("url") or (
            f"https://www.youtube.com/watch?v={entry['id']}" if entry.get("id") else None
        )
        if not entry_url:
            skipped += 1
            continue
        entries.append(
            PlaylistEntry(
                url=entry_url,
                title=entry["title"],
                uploader=entry.get("uploader") or entry.get("channel"),
                duration=entry.get("duration"),
                thumbnail=_thumbnail_of(entry),
            )
        )
    # yt-dlp's own total for the playlist, which flat extraction returns and
    # nothing read until #585. Falling back to the raw entry count rather than
    # to `len(entries)`: the point of the number is to disagree with what we
    # kept, and seeding it from what we kept would make it agree by construction
    # — a check that can only ever pass.
    announced = _int_or_none(info.get("playlist_count"))
    return PlaylistListing(
        title=info.get("title"),
        entries=entries,
        announced_count=announced if announced is not None else len(raw_entries),
        skipped=skipped,
    )


def _int_or_none(value: object) -> int | None:
    """`playlist_count` is an int when present and absent for some extractors."""
    return value if isinstance(value, int) else None


@dataclass
class ExtractedAudio:
    file_path: Path
    title: str
    artist: str
    album: str | None
    duration: float | None
    thumbnail_path: Path | None
    source_platform: str


def extract_and_download(url: str, out_dir: Path) -> ExtractedAudio:
    out_dir.mkdir(parents=True, exist_ok=True)
    ydl_opts = {
        **_network_opts(),
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "%(id)s.%(ext)s"),
        "writethumbnail": True,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        # Progress bars are written straight to stdout, which would interleave
        # raw text into our JSON log stream.
        "noprogress": True,
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            file_path = Path(ydl.prepare_filename(info))
    except yt_dlp.utils.DownloadError as exc:
        raise _extraction_error(exc) from exc

    thumbnail_path = None
    for ext in ("jpg", "jpeg", "png", "webp"):
        candidate = file_path.with_suffix(f".{ext}")
        if candidate.exists():
            thumbnail_path = candidate
            break

    return ExtractedAudio(
        file_path=file_path,
        title=info.get("title") or "Unknown title",
        # The real music metadata first: a Topic upload carries `artist`, and
        # only the channel name is left to fall back on (#307).
        artist=info.get("artist") or display_artist(info.get("uploader")) or "Unknown artist",
        album=info.get("album"),
        duration=info.get("duration"),
        thumbnail_path=thumbnail_path,
        source_platform=info.get("extractor_key") or info.get("extractor") or "unknown",
    )
