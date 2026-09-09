"""What yt-dlp hands back, turned into something worth showing a person (#307).

Every string in here is real. They were taken from a live extraction on
2026-08-05 while diagnosing "some titles are wrong, displayed as 'release', and
all tracks have '- Topic' after the song title" — and the diagnosis in the issue
turned out to be half wrong, which is why the evidence is written down.

**The titles were fine.** A flat listing returns `"稻香"`, not `"release"`. What
is wrong is the *artist*: YouTube's auto-generated Topic channels are named
`"<Artist> - Topic"`, and a great many Chinese uploads share one generic bucket
literally called **"Release - Topic"** — several unrelated tracks by different
artists, all under that one name. Strip the suffix and the word "Release" is
left standing where an artist should be, which is what was reported.
"""

from pathlib import Path

import pytest

from app.ytdlp import ExtractedAudio, display_artist, extract_and_download


class TestDisplayArtist:
    def test_takes_the_topic_suffix_off_a_real_artist(self) -> None:
        assert display_artist("AnnieTaco安妮塔克 - Topic") == "AnnieTaco安妮塔克"

    def test_leaves_an_ordinary_channel_completely_alone(self) -> None:
        # Including its spacing and punctuation: this is a display string, not a
        # comparison key. `matching.normalize()` would return "周杰倫 jay chou".
        assert display_artist("周杰倫 Jay Chou") == "周杰倫 Jay Chou"

    def test_says_nobody_rather_than_printing_a_generic_bucket(self) -> None:
        # The bug as reported. "Release" is not an artist, and showing it is
        # worse than admitting the artist is unknown.
        assert display_artist("Release - Topic") is None

    def test_is_not_fooled_by_case_or_spacing(self) -> None:
        assert display_artist("release - topic") is None
        assert display_artist("Some Artist-Topic") == "Some Artist"

    @pytest.mark.parametrize("uploader", [None, "", "   ", " - Topic"])
    def test_nothing_in_means_nothing_out(self, uploader: str | None) -> None:
        assert display_artist(uploader) is None


class TestExtractedArtist:
    """A full extraction knows the real artist; the flat listing never does."""

    def _extract(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, info: dict
    ) -> ExtractedAudio:
        class FakeYDL:
            def __init__(self, opts: dict) -> None:
                self.opts = opts

            def __enter__(self) -> "FakeYDL":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def extract_info(self, url: str, download: bool) -> dict:
                return info

            def prepare_filename(self, info: dict) -> str:
                return str(tmp_path / "abc.opus")

        monkeypatch.setattr("app.ytdlp.yt_dlp.YoutubeDL", FakeYDL)
        return extract_and_download("https://y/1", tmp_path)

    def test_prefers_the_music_metadata_over_the_channel(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # Exactly what the live extraction returned for 稻香: the channel names
        # nobody, and the `artist` field names the person who made it.
        result = self._extract(
            monkeypatch,
            tmp_path,
            {"title": "稻香", "artist": "周冠喆", "uploader": "Release - Topic", "album": "稻香"},
        )

        assert result.artist == "周冠喆"

    def test_cleans_the_channel_when_that_is_all_there_is(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        result = self._extract(
            monkeypatch, tmp_path, {"title": "稻香", "uploader": "AnnieTaco安妮塔克 - Topic"}
        )

        assert result.artist == "AnnieTaco安妮塔克"

    def test_falls_back_when_the_channel_names_nobody(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        result = self._extract(
            monkeypatch, tmp_path, {"title": "稻香", "uploader": "Release - Topic"}
        )

        assert result.artist == "Unknown artist"


class TestThumbnails:
    """Where a review row's picture comes from (#312).

    Checked against a live flat search on 2026-08-05, because the obvious guess
    is wrong: a flat entry's `thumbnail` key is **None**, and `thumbnails` is
    the populated one. Reading the singular yields nothing at all, silently.
    """

    def _entry(self, thumbnails: object) -> dict:
        return {"id": "abc", "title": "稻香", "thumbnails": thumbnails}

    def test_takes_the_url_a_real_flat_entry_carries(self) -> None:
        from app.ytdlp import _thumbnail_of

        entry = self._entry(
            [{"url": "https://i.ytimg.com/vi/abc/hqdefault.jpg", "width": 480, "height": 270}]
        )

        assert _thumbnail_of(entry) == "https://i.ytimg.com/vi/abc/hqdefault.jpg"

    def test_prefers_the_widest_that_is_not_extravagant(self) -> None:
        from app.ytdlp import _thumbnail_of

        entry = self._entry(
            [
                {"url": "small", "width": 120},
                {"url": "medium", "width": 480},
                # A 1280-wide image for a 44-point row is bytes nobody sees.
                {"url": "huge", "width": 1280},
            ]
        )

        assert _thumbnail_of(entry) == "medium"

    def test_takes_the_smallest_when_every_option_is_huge(self) -> None:
        from app.ytdlp import _thumbnail_of

        # A thumbnail that is too big beats no thumbnail: the row would
        # otherwise be blank for a video that has perfectly good artwork.
        entry = self._entry([{"url": "big", "width": 1920}, {"url": "less-big", "width": 1280}])

        assert _thumbnail_of(entry) == "less-big"

    def test_survives_an_entry_with_no_thumbnails_at_all(self) -> None:
        from app.ytdlp import _thumbnail_of

        assert _thumbnail_of({"id": "abc", "title": "x"}) is None
        assert _thumbnail_of(self._entry([])) is None
        assert _thumbnail_of(self._entry(None)) is None

    def test_ignores_entries_that_are_not_thumbnails(self) -> None:
        from app.ytdlp import _thumbnail_of

        # yt-dlp's shapes change between releases, and a search that raises
        # because one entry was a string is a search that returns nothing.
        assert _thumbnail_of(self._entry(["not-a-dict", {"no_url": 1}])) is None

    def test_copes_with_a_thumbnail_of_unknown_size(self) -> None:
        from app.ytdlp import _thumbnail_of

        assert _thumbnail_of(self._entry([{"url": "unsized"}])) == "unsized"


class TestThumbnailsReachTheCallers:
    """The thumbnail survives the two functions that build the objects.

    Written after mutation testing showed the first pair of tests could not see
    these lines at all: they monkeypatch `list_playlist` and `score_candidates`
    and hand in objects that already carry a thumbnail, so deleting the code
    that *puts* it there changed nothing they could observe. A test downstream
    of the bug is not a test of the bug.
    """

    def _fake_ydl(self, monkeypatch: pytest.MonkeyPatch, info: dict) -> None:
        class FakeYDL:
            def __init__(self, opts: dict) -> None:
                self.opts = opts

            def __enter__(self) -> "FakeYDL":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def extract_info(self, url: str, download: bool = False) -> dict:
                return info

        monkeypatch.setattr("app.ytdlp.yt_dlp.YoutubeDL", FakeYDL)

    ENTRY = {
        "id": "abc",
        "title": "稻香",
        "url": "https://www.youtube.com/watch?v=abc",
        "uploader": "周杰倫 Jay Chou",
        "duration": 224,
        "thumbnails": [{"url": "https://i.ytimg.com/vi/abc/hq.jpg", "width": 480}],
    }

    def test_a_listed_playlist_entry_carries_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.ytdlp import list_playlist

        self._fake_ydl(monkeypatch, {"title": "Mix", "entries": [self.ENTRY]})

        listing = list_playlist("https://youtube.com/playlist?list=x")

        assert listing.entries[0].thumbnail == "https://i.ytimg.com/vi/abc/hq.jpg"

    def test_a_search_result_carries_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.ytdlp import search

        self._fake_ydl(monkeypatch, {"entries": [self.ENTRY]})

        results = search("稻香")

        assert results[0].thumbnail == "https://i.ytimg.com/vi/abc/hq.jpg"
