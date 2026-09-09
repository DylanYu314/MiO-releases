"""Behavioural specification for app/matching.py.

Mostly property-style ("an obvious match must auto-accept", "a worse duration
scores lower") rather than exact arithmetic, so the scoring formula can be
tuned without rewriting the suite — only the classify thresholds are pinned.
"""

import pytest

from app.matching import (
    AUTO_THRESHOLD,
    REVIEW_THRESHOLD,
    _is_topic_channel,
    build_search_query,
    classify,
    normalize,
    score_candidates,
)
from app.models import TrackMatchStatus
from app.ytdlp import SearchResult


def result(
    title: str,
    uploader: str | None = "Some Channel",
    duration: float | None = None,
    url: str = "https://www.youtube.com/watch?v=x",
    source: str = "youtube",
) -> SearchResult:
    return SearchResult(url=url, title=title, uploader=uploader, duration=duration, source=source)


# ---------------------------------------------------------------- normalize

NORMALIZE_CASES = [
    # Release furniture in brackets disappears...
    ("Never Gonna Give You Up (Official Video)", "never gonna give you up"),
    ("Song [Official Audio]", "song"),
    ("Song (Official Lyric Video)", "song"),
    ("Song [4K Remaster]", "song"),
    # ...but meaningful qualifiers survive: a live take is a different recording.
    ("Song (Live)", "song live"),
    # Case, diacritics and stray punctuation don't count as differences.
    ("Tïtlé", "title"),
    ("MiXeD CaSe!!!", "mixed case"),
    ("Song   with\todd   spacing", "song with odd spacing"),
    # Featuring clauses and YouTube's auto-channel suffix are noise.
    ("Song (feat. Somebody)", "song"),
    ("Song ft. Somebody", "song"),
    ("Rick Astley - Topic", "rick astley"),
    # Non-Latin scripts pass through untouched.
    ("曲名", "曲名"),
]


@pytest.mark.parametrize(("raw", "expected"), NORMALIZE_CASES)
def test_normalize(raw: str, expected: str) -> None:
    assert normalize(raw) == expected


# ------------------------------------------------------- build_search_query


def test_search_query_is_artist_then_title() -> None:
    assert (
        build_search_query("Never Gonna Give You Up", "Rick Astley")
        == "Rick Astley Never Gonna Give You Up"
    )


def test_search_query_uses_only_the_primary_artist() -> None:
    assert build_search_query("Song", "Artist A, Artist B, Artist C") == "Artist A Song"


# ---------------------------------------------------------------- classify


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (None, TrackMatchStatus.NO_MATCH),
        (0.0, TrackMatchStatus.NO_MATCH),
        (REVIEW_THRESHOLD - 0.0001, TrackMatchStatus.NO_MATCH),
        (REVIEW_THRESHOLD, TrackMatchStatus.NEEDS_REVIEW),
        (AUTO_THRESHOLD - 0.0001, TrackMatchStatus.NEEDS_REVIEW),
        (AUTO_THRESHOLD, TrackMatchStatus.AUTO_MATCHED),
        (1.0, TrackMatchStatus.AUTO_MATCHED),
    ],
)
def test_classify_thresholds(score: float | None, expected: TrackMatchStatus) -> None:
    assert classify(score) == expected


# --------------------------------------------------------- score_candidates

WANTED_TITLE = "Never Gonna Give You Up"
WANTED_ARTIST = "Rick Astley"
WANTED_DURATION = 213.0


def score_one(candidate: SearchResult) -> float:
    scored = score_candidates(WANTED_TITLE, WANTED_ARTIST, WANTED_DURATION, [candidate])
    assert len(scored) == 1
    return scored[0].score


def test_no_results_scores_to_an_empty_list() -> None:
    assert score_candidates(WANTED_TITLE, WANTED_ARTIST, WANTED_DURATION, []) == []


def test_an_obvious_match_auto_accepts() -> None:
    candidate = result(
        "Rick Astley - Never Gonna Give You Up (Official Video)",
        uploader="Rick Astley",
        duration=212.0,
    )
    assert score_one(candidate) >= AUTO_THRESHOLD


def test_an_unrelated_result_lands_below_the_review_band() -> None:
    candidate = result(
        "10 Hours of Relaxing Rain Sounds",
        uploader="Relaxation Station",
        duration=36000.0,
    )
    assert score_one(candidate) < REVIEW_THRESHOLD


def test_a_worse_duration_scores_lower() -> None:
    close = result("Rick Astley - Never Gonna Give You Up", "Rick Astley", duration=212.0)
    far = result("Rick Astley - Never Gonna Give You Up", "Rick Astley", duration=340.0)
    assert score_one(close) > score_one(far)


def test_an_unknown_duration_is_neutral_not_fatal() -> None:
    """A clearly-right title and artist with no duration info must still
    auto-accept — many flat search results carry no duration."""
    candidate = result("Rick Astley - Never Gonna Give You Up", "Rick Astley", duration=None)
    assert score_one(candidate) >= AUTO_THRESHOLD


def test_a_topic_channel_never_scores_worse_than_a_plain_one() -> None:
    plain = result("Never Gonna Give You Up", uploader="Rick Astley", duration=213.0)
    topic = result("Never Gonna Give You Up", uploader="Rick Astley - Topic", duration=213.0)
    assert score_one(topic) >= score_one(plain)


def test_the_topic_bonus_is_youtubes_alone() -> None:
    """ADR-013 decision 4, enforced by #551.

    A "- Topic" uploader is a YouTube naming convention for auto-generated
    album audio. No Bilibili uploader can earn it, so applying the bonus to a
    Bilibili candidate with that name would be a nudge that means nothing —
    and, in a mixed candidate list, would tilt every comparison towards
    YouTube for a reason unrelated to the music.
    """
    # `duration=None` deliberately. With a perfect title, artist *and* duration
    # the base score is already 1.0 and the clamp in `score_candidates` hides
    # the bonus entirely — which is why the older Topic test could only assert
    # `>=`. An unknown duration scores a neutral 0.5, leaving 0.075 of headroom.
    on_youtube = result("Never Gonna Give You Up", uploader="Rick Astley - Topic")
    on_bilibili = result(
        "Never Gonna Give You Up",
        uploader="Rick Astley - Topic",
        url="https://www.bilibili.com/video/BV1xx411c7mD",
        source="bilibili",
    )
    plain = result("Never Gonna Give You Up", uploader="Rick Astley")

    # Identical in every respect but the source, so the gap *is* the bonus.
    assert score_one(on_youtube) > score_one(on_bilibili)
    assert score_one(on_bilibili) == score_one(plain)
    assert score_one(on_youtube) - score_one(on_bilibili) == pytest.approx(0.05)


def test_a_candidate_keeps_the_source_it_was_found_on() -> None:
    """The review screen has to be able to say where a match came from; a mixed
    list of candidates is unreadable without it."""
    scored = score_candidates(
        "Never Gonna Give You Up",
        "Rick Astley",
        213.0,
        [
            result("Never Gonna Give You Up", duration=213.0),
            result(
                "Never Gonna Give You Up",
                duration=213.0,
                url="https://www.bilibili.com/video/BV1xx411c7mD",
                source="bilibili",
            ),
        ],
    )

    assert {candidate.source for candidate in scored} == {"youtube", "bilibili"}


def test_an_unsourced_result_defaults_to_youtube() -> None:
    """`SearchResult.source` defaults to youtube, which is what every caller
    predating #551 means.

    Built directly rather than through `result()` above: that helper has a
    default of its own, so going through it would assert the *test's* choice
    and pass no matter what the dataclass says. A mutation flipping the real
    default to bilibili survived until this was written this way.
    """
    bare = SearchResult(url="https://y.t/1", title="t", uploader=None, duration=None)
    assert bare.source == "youtube"
    assert _is_topic_channel("Rick Astley - Topic", bare.source) is True


def test_scores_stay_inside_the_unit_interval() -> None:
    best_possible = result(
        "Never Gonna Give You Up", uploader="Rick Astley - Topic", duration=213.0
    )
    worst_possible = result("zzzzzz", uploader=None, duration=1.0)
    assert 0.0 <= score_one(worst_possible) <= 1.0
    assert 0.0 <= score_one(best_possible) <= 1.0


def test_results_come_back_sorted_best_first() -> None:
    candidates = [
        result("Unrelated Podcast Episode 47", uploader="Podcasts", duration=3600.0),
        result("Rick Astley - Never Gonna Give You Up", "Rick Astley", duration=212.0),
        result("Never Gonna Give You Up (Piano Cover)", uploader="Piano Guy", duration=250.0),
    ]

    scored = score_candidates(WANTED_TITLE, WANTED_ARTIST, WANTED_DURATION, candidates)

    scores = [candidate.score for candidate in scored]
    assert scores == sorted(scores, reverse=True)
    assert "rick astley" in scored[0].title.lower()


def test_scored_candidates_carry_their_source_fields() -> None:
    candidate = result(
        "Rick Astley - Never Gonna Give You Up",
        uploader="Rick Astley",
        duration=212.0,
        url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    )

    top = score_candidates(WANTED_TITLE, WANTED_ARTIST, WANTED_DURATION, [candidate])[0]

    assert top.url == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert top.title == "Rick Astley - Never Gonna Give You Up"
    assert top.uploader == "Rick Astley"
    assert top.duration == 212.0


def test_scoring_carries_the_thumbnail_through() -> None:
    """#312: a candidate the user is choosing between needs a picture.

    The scorer's job is the number, but it is also the only thing that turns a
    `SearchResult` into a `ScoredCandidate` — so anything the client needs has
    to survive the crossing.
    """
    from app.matching import score_candidates
    from app.ytdlp import SearchResult

    scored = score_candidates(
        "稻香",
        "周杰倫",
        224.0,
        [
            SearchResult(
                url="https://youtu.be/abc",
                title="稻香",
                uploader="周杰倫 Jay Chou",
                duration=224.0,
                thumbnail="https://i.ytimg.com/vi/abc/hq.jpg",
            )
        ],
    )

    assert scored[0].thumbnail == "https://i.ytimg.com/vi/abc/hq.jpg"
