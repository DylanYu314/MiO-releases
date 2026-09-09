"""Scoring for Spotify→YouTube track matching. Pure functions, no I/O.

tests/test_matching.py is the behavioural specification. The pipeline
(app/playlist_imports.py) only touches this module through the names below,
so nothing else in the app needs to change as the scorer evolves.
"""

import re
import unicodedata
from dataclasses import dataclass

from rapidfuzz import fuzz

from app.models import TrackMatchStatus
from app.ytdlp import SearchResult

# Confidence ≥ AUTO_THRESHOLD is pre-accepted; [REVIEW_THRESHOLD, AUTO) needs
# a human look; below REVIEW_THRESHOLD counts as no usable match.
AUTO_THRESHOLD = 0.80
REVIEW_THRESHOLD = 0.55

# How many search results to score and keep per track.
CANDIDATE_LIMIT = 5

# Score = weighted title/artist string similarity + duration closeness.
# Title dominates: it's the one field both sides always have.
_TITLE_WEIGHT = 0.55
_ARTIST_WEIGHT = 0.30
_DURATION_WEIGHT = 0.15

# "<Artist> - Topic" channels are YouTube's auto-generated exact album audio —
# worth a nudge over lookalike uploads, but never enough to flip a bad match.
#
# ⚠️ **It is YouTube's alone, and that is now enforced rather than incidental.**
# ADR-013 decision 4 recorded that this bonus is structurally unfair the moment
# a second candidate source exists — no Bilibili uploader can earn it — and
# required it to move behind a per-source rule "in the same change" as that
# source. #551 is that change.
_TOPIC_BONUS = 0.05

# The one source whose uploader names carry the " - Topic" convention.
_TOPIC_SOURCE = "youtube"

# How much a candidate loses for announcing that it is not the recording (#674).
#
# `token_set_ratio` returns a *perfect* score whenever one side's tokens are a
# subset of the other's. That is deliberate — it is what lets
# "Guns N' Roses - November Rain (Official Video)" match "November Rain" — but
# it makes extra words free. Measured 2026-08-21 on a device:
# "November Rain【Guns N'Roses】枪花 动态鼓谱" — an animated *drum score*, not
# the song — scored 0.995 and was auto-matched, so it was downloaded without
# reaching review. The library row still read "November Rain - Guns N' Roses",
# because title and artist come from Spotify, and only playing it revealed it.
#
# 0.25 takes a perfect 1.0 to 0.75: below _AUTO_THRESHOLD (0.8) and above
# _REVIEW_THRESHOLD (0.55). So it can never be accepted silently, and is still
# offered with its title visible for a human to judge. Excluding it outright
# would be worse when it is the only result.
_NON_RECORDING_PENALTY = 0.25

# Titles that say "this is not the recording".
#
# Matched as *substrings*, not tokens: Chinese does not use spaces, so
# normalize() leaves 动态鼓谱 as one token and token comparison would never
# see 鼓谱 inside it.
#
# Deliberately narrow — every entry must mean "not the recording" on its own.
# 伴奏 (backing track) and "cover" were considered and left out: a cover is a
# real performance somebody may want, and a false demotion is the same silent
# failure as a false promotion, in the other direction.
_NON_RECORDING_MARKERS = (
    "鼓谱",  # drum score - the one that caused #674
    "吉他谱",  # guitar tab
    "贝斯谱",  # bass tab
    "钢琴谱",  # piano score
    "简谱",  # numbered notation
    "教学",  # tutorial
    "教程",  # tutorial
    "翻弹",  # instrument re-performance
    "试听",  # preview clip
)

# Duration deltas: full credit within the encoder-rounding range, no credit
# once the gap says "different recording" (radio edit, extended mix, cover).
_DURATION_FULL_CREDIT_S = 2.0
_DURATION_ZERO_CREDIT_S = 30.0

# Words that are release furniture, not song identity. A bracketed segment
# made only of these (plus bare numbers, e.g. remaster years) is dropped.
_NOISE_WORDS = frozenset(
    {
        "official",
        "video",
        "lyric",
        "lyrics",
        "audio",
        "visualizer",
        "visualiser",
        "mv",
        "hd",
        "hq",
        "4k",
        "8k",
        "music",
        "remaster",
        "remastered",
    }
)

_BRACKETED = re.compile(r"[(\[][^)\]]*[)\]]")
# "feat"/"ft"/"featuring" and everything after it, stopping at a closing
# bracket so "Song (feat. X)" leaves the brackets to be cleaned up below.
_FEAT_CLAUSE = re.compile(r"\b(?:feat|ft|featuring)\b\.?[^)\]]*")
_TOPIC_SUFFIX = re.compile(r"\s*-\s*topic\s*$")
_PUNCTUATION = re.compile(r"[^\w\s]")
_WHITESPACE = re.compile(r"\s+")


@dataclass
class ScoredCandidate:
    url: str
    title: str
    uploader: str | None
    duration: float | None
    score: float
    thumbnail: str | None = None
    # Carried onto the stored candidate so the review screen can say where a
    # match came from — a mixed list is unreadable without it (#551).
    source: str = "youtube"


def build_search_query(title: str, artist: str) -> str:
    """The YouTube search text for a track, e.g. "Rick Astley Never Gonna
    Give You Up". Only the primary artist: feat-lists just add noise."""
    primary_artist = artist.split(",")[0].strip()
    return f"{primary_artist} {title}".strip()


def _drop_noise_brackets(match: re.Match[str]) -> str:
    words = _PUNCTUATION.sub(" ", match.group(0)).split()
    if words and all(word in _NOISE_WORDS or word.isdigit() for word in words):
        return " "
    return match.group(0)


def normalize(text: str) -> str:
    """Reduce a title/artist/uploader string to its comparable core.

    Case, diacritics, punctuation and release furniture ("(Official Video)",
    "feat. …", a trailing " - Topic") don't make two strings different songs —
    but meaningful qualifiers like "(Live)" do, so only brackets made purely
    of noise words are dropped. CJK and other scripts pass through.
    """
    text = unicodedata.normalize("NFKC", text).casefold()
    decomposed = unicodedata.normalize("NFD", text)
    text = "".join(char for char in decomposed if not unicodedata.combining(char))
    text = _BRACKETED.sub(_drop_noise_brackets, text)
    text = _FEAT_CLAUSE.sub(" ", text)
    text = _TOPIC_SUFFIX.sub(" ", text)
    text = _PUNCTUATION.sub(" ", text)
    return _WHITESPACE.sub(" ", text).strip()


def _similarity(wanted: str, candidate: str) -> float:
    """Normalized-string similarity in 0..1. `token_set_ratio` ignores word
    order and rewards subset matches, which suits candidate titles shaped
    like "Artist - Title (Official Video)"."""
    if not wanted or not candidate:
        return 0.0
    return fuzz.token_set_ratio(wanted, candidate) / 100


def _duration_score(wanted_s: float | None, candidate_s: float | None) -> float:
    """1.0 within ~2 s, fading linearly to 0.0 by ~30 s off — the cheapest
    strong discriminator against covers, edits and sped-up versions. Unknown
    durations stay neutral (0.5) rather than punishing the candidate."""
    if wanted_s is None or candidate_s is None:
        return 0.5
    delta = abs(wanted_s - candidate_s)
    if delta <= _DURATION_FULL_CREDIT_S:
        return 1.0
    if delta >= _DURATION_ZERO_CREDIT_S:
        return 0.0
    return 1.0 - (delta - _DURATION_FULL_CREDIT_S) / (
        _DURATION_ZERO_CREDIT_S - _DURATION_FULL_CREDIT_S
    )


def _is_topic_channel(uploader: str | None, source: str) -> bool:
    """Whether this candidate earns {@link _TOPIC_BONUS}.

    Gated on the source, not only on the name: "- Topic" is a YouTube naming
    convention, and a Bilibili uploader who happened to call themselves that
    would otherwise collect a bonus meaning nothing.
    """
    if source != _TOPIC_SOURCE:
        return False
    return uploader is not None and uploader.strip().casefold().endswith(" - topic")


def _announces_not_the_recording(wanted_title: str, candidate_title: str) -> bool:
    """Does the candidate say it is not the recording, when the wanted title does not?

    The second half is the whole safety of this. A track legitimately called
    教学 must not be penalised for matching a candidate also called 教学 —
    the penalty applies only to a marker the *candidate* introduces.
    """
    return any(
        marker in candidate_title and marker not in wanted_title
        for marker in _NON_RECORDING_MARKERS
    )


def score_candidates(
    title: str,
    artist: str,
    duration_s: float | None,
    results: list[SearchResult],
) -> list[ScoredCandidate]:
    """Score each search result 0..1 against the wanted track, best first.

    The artist term takes the better of comparing against the candidate's
    title and its uploader — either may carry the artist name, depending on
    whether the upload is "Artist - Title" on a random channel or a bare
    title on the artist's own channel.
    """
    wanted_title = normalize(title)
    wanted_artist = normalize(artist)

    scored = []
    for result in results:
        candidate_title = normalize(result.title)
        candidate_uploader = normalize(result.uploader) if result.uploader else ""

        title_sim = _similarity(wanted_title, candidate_title)
        artist_sim = max(
            _similarity(wanted_artist, candidate_title),
            _similarity(wanted_artist, candidate_uploader),
        )
        score = (
            _TITLE_WEIGHT * title_sim
            + _ARTIST_WEIGHT * artist_sim
            + _DURATION_WEIGHT * _duration_score(duration_s, result.duration)
        )
        if _is_topic_channel(result.uploader, result.source):
            score += _TOPIC_BONUS
        if _announces_not_the_recording(wanted_title, candidate_title):
            score -= _NON_RECORDING_PENALTY

        scored.append(
            ScoredCandidate(
                url=result.url,
                title=result.title,
                uploader=result.uploader,
                duration=result.duration,
                score=max(0.0, min(1.0, score)),
                thumbnail=result.thumbnail,
                source=result.source,
            )
        )

    scored.sort(key=lambda candidate: candidate.score, reverse=True)
    return scored


def classify(best_score: float | None) -> TrackMatchStatus:
    """Map a track's best candidate score to its initial match status."""
    if best_score is None or best_score < REVIEW_THRESHOLD:
        return TrackMatchStatus.NO_MATCH
    if best_score >= AUTO_THRESHOLD:
        return TrackMatchStatus.AUTO_MATCHED
    return TrackMatchStatus.NEEDS_REVIEW
