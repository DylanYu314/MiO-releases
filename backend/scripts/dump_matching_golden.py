"""Write `shared/matching-golden.json` — the cross-language matching fixture.

#353 split matching so the phone searched and the server scored, *"because one
matcher cannot drift from itself"*. #608 removes the server from the product and
#609 ports the scorer to TypeScript, so that argument no longer holds. This
script replaces it with a **mechanism**: a corpus scored by this module, which
`backend/tests/test_matching_golden.py` and
`mobile/__tests__/matchingGolden.test.ts` both assert against.

`shared/` is in no workflow's `paths-ignore`, so a change here runs backend
*and* mobile CI.

⚠️ **Run with `-m`, never as a path** — `python scripts/dump_matching_golden.py`
puts `scripts/` on `sys.path[0]` and `app` then resolves to the stale copy in
site-packages:

    docker compose exec backend python -m scripts.dump_matching_golden

The three layers are dumped separately (`normalize`, `token_set_ratio`, then
whole-candidate scoring) so a failure **names which one broke** rather than
reporting one opaque number — the #303 lesson, where a boolean could not be
diagnosed and only a name solved it.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from app import matching
from app.ytdlp import SearchResult

GOLDEN_PATH = Path(__file__).resolve().parents[2] / "shared" / "matching-golden.json"
CASE_FOLD_PATH = Path(__file__).resolve().parents[2] / "shared" / "case-fold.json"


def build_case_fold() -> dict[str, str]:
    """Every code point whose `str.casefold()` differs from `str.lower()`.

    ⚠️ **This table is not decoration.** JavaScript has no `casefold`, and
    `toLowerCase()` is not the same function: Python folds ß→ss and ς→σ, and
    leaves Cherokee capitals alone where JavaScript lowercases them. The golden
    fixture caught exactly this on the first run (`"Straße"` → `"strasse"` vs
    `"straße"`), which is what a cross-language guard is *for*.

    Generated rather than hand-written so the two languages cannot disagree
    about what the table should contain.
    """
    return {
        chr(cp): chr(cp).casefold()
        for cp in range(0x110000)
        if chr(cp).casefold() != chr(cp).lower()
    }


@dataclass
class Case:
    name: str
    title: str
    artist: str
    duration_s: float | None
    results: list[SearchResult]


# Strings chosen to exercise each branch of `normalize()`, not to look realistic.
NORMALIZE_CASES: list[str] = [
    "Never Gonna Give You Up",
    "Blinding Lights (Official Video)",
    "Blinding Lights (Live)",
    "Song (Official Music Video) [4K Remastered]",
    "Track [Remastered 2011]",
    "Levitating (feat. DaBaby)",
    "Levitating feat. DaBaby",
    "Song ft. Someone",
    "Rick Astley - Topic",
    "Café Déjà Vu",
    "ＦＵＬＬＷＩＤＴＨ　Ｔｉｔｌｅ",
    "周杰倫 - 稻香",
    "薛之谦《演员》",
    "  spaced   out  ",
    "ALL CAPS TITLE",
    "Straße",
    "",
    "(Official Video)",
    "[MV] 노래",
    "Song (Remix) (Official Audio)",
]

# Pairs that pin `token_set_ratio` itself, including the two early exits.
TOKEN_SET_PAIRS: list[tuple[str, str]] = [
    ("fuzzy was a bear", "fuzzy fuzzy was a bear"),
    ("fuzzy was a bear but not a dog", "fuzzy was a bear"),
    ("fuzzy was a bear but not a dog", "fuzzy was a bear but not a cat"),
    ("", "anything"),
    ("anything", ""),
    ("identical tokens", "identical tokens"),
    ("completely different", "nothing alike here"),
    ("a", "b"),
    ("one two three", "three two one"),
    ("稻香", "周杰倫 稻香"),
    ("演员 薛之谦", "薛之谦 演员 官方"),
    ("single", "single single single"),
]


def _r(
    url: str,
    title: str,
    uploader: str | None,
    duration: float | None,
    source: str = "youtube",
) -> SearchResult:
    return SearchResult(url=url, title=title, uploader=uploader, duration=duration, source=source)


CASES: list[Case] = [
    Case(
        # ⚠️ The real #674 case, verbatim from a device on 2026-08-21. Before the
        # fix this scored **0.995** and classified `auto_matched`, so it was
        # downloaded without ever reaching review — and the library row still
        # read "November Rain — Guns N' Roses", because title and artist come
        # from Spotify. The drum-score row must now sit below _AUTO_THRESHOLD.
        name="a drum score is not the recording (#674)",
        title="November Rain",
        artist="Guns N' Roses",
        duration_s=537.0,
        results=[
            _r(
                "https://b/674a",
                "November Rain【Guns N'Roses】枪花 动态鼓谱",
                "鼓谱君",
                540.0,
                "bilibili",
            ),
            _r(
                "https://b/674b",
                "Guns N' Roses - November Rain",
                "Guns N' Roses",
                537.0,
                "bilibili",
            ),
        ],
    ),
    Case(
        # ⚠️ The safety half, and the reason the rule compares both sides. A
        # track whose *own* title carries the marker must keep its score; only
        # a marker the candidate introduces is penalised. Without this case the
        # fixture would pass with the wanted-title check deleted.
        name="a marker in the wanted title is not a demotion (#674)",
        title="爵士鼓教学",
        artist="somebody",
        duration_s=200.0,
        results=[
            _r("https://b/674c", "爵士鼓教学", "somebody", 200.0, "bilibili"),
            _r("https://b/674d", "爵士鼓教学 完整版", "somebody", 200.0, "bilibili"),
        ],
    ),
    Case(
        name="exact match on a Topic channel",
        title="Never Gonna Give You Up",
        artist="Rick Astley",
        duration_s=213.0,
        results=[
            _r("https://y/1", "Never Gonna Give You Up", "Rick Astley - Topic", 213.0),
            _r("https://y/2", "Never Gonna Give You Up (Official Video)", "RickAstleyVEVO", 213.0),
            _r("https://y/3", "Never Gonna Give You Up - Cover", "Some Guy", 240.0),
        ],
    ),
    Case(
        # ⚠️ Deliberately *unsaturated*. The obvious fixture — a perfect title,
        # artist and duration on both rows — scores 1.0 either way, the bonus
        # clamps away, and deleting the source gate passes. Scores here sit near
        # 0.7 so the 0.05 is arithmetically visible.
        name="the Topic bonus is YouTube's alone (#552)",
        title="Never Gonna Give You Up",
        artist="Rick Astley",
        duration_s=213.0,
        results=[
            _r(
                "https://b/1",
                "Never Gonna Give You Up Extended",
                "Rick Astley - Topic",
                225.0,
                "bilibili",
            ),
            _r(
                "https://y/1",
                "Never Gonna Give You Up Extended",
                "Rick Astley - Topic",
                225.0,
                "youtube",
            ),
        ],
    ),
    Case(
        # The bonus has to be able to *change the answer*, or a test that only
        # reads scores cannot tell an applied bonus from an ignored one.
        name="the Topic bonus can change the winner",
        title="Yesterday",
        artist="The Beatles",
        duration_s=125.0,
        results=[
            _r("https://y/plain", "Yesterday Remastered", "The Beatles Fan Uploads", 131.0),
            _r("https://y/topic", "Yesterday Remaster", "The Beatles - Topic", 131.0),
        ],
    ),
    Case(
        name="duration boundaries — 2s, 16s and 30s off",
        title="Some Song",
        artist="Some Artist",
        duration_s=200.0,
        results=[
            _r("https://y/exact", "Some Song", "Some Artist", 202.0),
            _r("https://y/mid", "Some Song", "Some Artist", 216.0),
            _r("https://y/far", "Some Song", "Some Artist", 230.0),
            _r("https://y/beyond", "Some Song", "Some Artist", 400.0),
        ],
    ),
    Case(
        name="missing durations stay neutral",
        title="Some Song",
        artist="Some Artist",
        duration_s=None,
        results=[
            _r("https://y/1", "Some Song", "Some Artist", None),
            _r("https://y/2", "Some Song", "Some Artist", 200.0),
        ],
    ),
    Case(
        name="artist may be in the title or the uploader",
        title="Blinding Lights",
        artist="The Weeknd",
        duration_s=200.0,
        results=[
            _r("https://y/1", "The Weeknd - Blinding Lights", "RandomUploads", 200.0),
            _r("https://y/2", "Blinding Lights", "The Weeknd", 200.0),
            _r("https://y/3", "Blinding Lights", "Nobody In Particular", 200.0),
        ],
    ),
    Case(
        name="bracketed noise is dropped, meaningful brackets are not",
        title="Levitating",
        artist="Dua Lipa",
        duration_s=203.0,
        results=[
            _r("https://y/1", "Levitating (Official Music Video)", "Dua Lipa", 203.0),
            _r("https://y/2", "Levitating (Live)", "Dua Lipa", 203.0),
            _r("https://y/3", "Levitating (feat. DaBaby)", "Dua Lipa", 203.0),
        ],
    ),
    Case(
        name="CJK titles pass through",
        title="稻香",
        artist="周杰倫",
        duration_s=223.0,
        results=[
            _r("https://y/1", "周杰倫 - 稻香", "JVR Music", 223.0),
            _r("https://y/2", "稻香", "周杰倫 - Topic", 223.0),
            _r("https://b/1", "【周杰倫】稻香 完整版", "音樂搬運工", 223.0, "bilibili"),
        ],
    ),
    Case(
        name="empty artist",
        title="Instrumental Piece",
        artist="",
        duration_s=180.0,
        results=[
            _r("https://y/1", "Instrumental Piece", None, 180.0),
            _r("https://y/2", "Instrumental Piece", "Some Channel", 180.0),
        ],
    ),
    Case(
        # ⚠️ #618: the device carried its own query builder that did **not**
        # split on the comma, so every multi-artist track was searched with a
        # noisier string than the scorer expects. The fixture dumps
        # `build_search_query` per case, so this pins the split in both
        # languages.
        name="a feat-list is trimmed to the primary artist",
        title="Levitating",
        artist="Dua Lipa, DaBaby",
        duration_s=203.0,
        results=[
            _r("https://y/1", "Levitating (feat. DaBaby)", "Dua Lipa", 203.0),
        ],
    ),
    Case(
        name="no candidates at all",
        title="Obscure Track",
        artist="Nobody",
        duration_s=120.0,
        results=[],
    ),
    Case(
        name="only bad candidates — below the review threshold",
        title="Very Specific Song Title",
        artist="Very Specific Artist",
        duration_s=200.0,
        results=[
            _r("https://y/1", "Completely Unrelated Upload", "Random", 45.0),
            _r("https://y/2", "Another Thing Entirely", "Someone Else", 600.0),
        ],
    ),
    Case(
        name="ties keep input order",
        title="Same",
        artist="Same",
        duration_s=100.0,
        results=[
            _r("https://y/first", "Same", "Same", 100.0),
            _r("https://y/second", "Same", "Same", 100.0),
            _r("https://y/third", "Same", "Same", 100.0),
        ],
    ),
    Case(
        name="diacritics and full-width fold together",
        title="Café Déjà Vu",
        artist="Amélie",
        duration_s=150.0,
        results=[
            _r("https://y/1", "Cafe Deja Vu", "Amelie", 150.0),
            _r("https://y/2", "ＣＡＦＥ　ＤＥＪＡ　ＶＵ", "Ａｍｅｌｉｅ", 150.0),
        ],
    ),
]


def _dump_case(case: Case) -> dict:
    scored = matching.score_candidates(case.title, case.artist, case.duration_s, case.results)
    best = scored[0].score if scored else None
    return {
        "name": case.name,
        "title": case.title,
        "artist": case.artist,
        "duration_s": case.duration_s,
        "results": [
            {
                "url": r.url,
                "title": r.title,
                "uploader": r.uploader,
                "duration": r.duration,
                "source": r.source,
            }
            for r in case.results
        ],
        "expected": {
            "query": matching.build_search_query(case.title, case.artist),
            "scored": [
                {"url": c.url, "score": c.score, "source": c.source, "uploader": c.uploader}
                for c in scored
            ],
            "status": matching.classify(best).value,
        },
    }


def build() -> dict:
    return {
        "_comment": (
            "Generated by backend/scripts/dump_matching_golden.py. Do not edit by hand. "
            "Asserted by backend/tests/test_matching_golden.py and "
            "mobile/__tests__/matchingGolden.test.ts — both must agree (#609)."
        ),
        "thresholds": {
            "auto": matching.AUTO_THRESHOLD,
            "review": matching.REVIEW_THRESHOLD,
            "candidate_limit": matching.CANDIDATE_LIMIT,
        },
        "normalize": [
            {"input": text, "output": matching.normalize(text)} for text in NORMALIZE_CASES
        ],
        "token_set_ratio": [
            {"a": a, "b": b, "ratio": matching._similarity(a, b)} for a, b in TOKEN_SET_PAIRS
        ],
        "cases": [_dump_case(case) for case in CASES],
    }


def main() -> None:
    GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    case_fold = build_case_fold()
    CASE_FOLD_PATH.write_text(
        json.dumps(case_fold, indent=0, ensure_ascii=False, sort_keys=True) + "\n", "utf-8"
    )
    print(f"wrote {CASE_FOLD_PATH} ({len(case_fold)} entries)")
    GOLDEN_PATH.write_text(json.dumps(build(), indent=2, ensure_ascii=False) + "\n", "utf-8")
    print(f"wrote {GOLDEN_PATH}")


if __name__ == "__main__":
    main()
