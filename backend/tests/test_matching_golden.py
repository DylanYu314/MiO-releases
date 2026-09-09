"""The backend half of the cross-language matching guard (#609).

`shared/matching-golden.json` is generated from `app/matching.py` by
`scripts/dump_matching_golden.py`. This module asserts Python still reproduces
it; `mobile/__tests__/matchingGolden.test.ts` asserts the TypeScript port does
too.

⚠️ **A failure here means one of two things**, and they need opposite responses:

- the scorer changed **deliberately** → regenerate the fixture *and* let mobile
  CI confirm the port still agrees, in the same PR
- the scorer changed **accidentally** → fix the scorer; regenerating hides it

Without this half the fixture only ever proves the port matches a snapshot, and
a change to `matching.py` alone would sail through. #540's shape one level out:
absorbing B into A does not make A's completion evidence about B.
"""

import json
from pathlib import Path

import pytest

from app import matching
from app.ytdlp import SearchResult

GOLDEN_PATH = Path(__file__).resolve().parents[2] / "shared" / "matching-golden.json"


@pytest.fixture(scope="module")
def golden() -> dict:
    return json.loads(GOLDEN_PATH.read_text("utf-8"))


def test_fixture_is_not_empty(golden: dict) -> None:
    """A control. Every other test parametrises over the fixture, so an empty
    one would leave the suite green and proving nothing (#523)."""
    assert len(golden["cases"]) > 5
    assert len(golden["normalize"]) > 5
    assert len(golden["token_set_ratio"]) > 5


def test_thresholds_match(golden: dict) -> None:
    assert matching.AUTO_THRESHOLD == golden["thresholds"]["auto"]
    assert matching.REVIEW_THRESHOLD == golden["thresholds"]["review"]
    assert matching.CANDIDATE_LIMIT == golden["thresholds"]["candidate_limit"]


def test_normalize_matches(golden: dict) -> None:
    for entry in golden["normalize"]:
        assert matching.normalize(entry["input"]) == entry["output"], entry["input"]


def test_token_set_ratio_matches(golden: dict) -> None:
    for entry in golden["token_set_ratio"]:
        actual = matching._similarity(entry["a"], entry["b"])
        assert actual == pytest.approx(entry["ratio"], abs=1e-12), (entry["a"], entry["b"])


def test_scoring_matches(golden: dict) -> None:
    for case in golden["cases"]:
        results = [
            SearchResult(
                url=r["url"],
                title=r["title"],
                uploader=r["uploader"],
                duration=r["duration"],
                source=r["source"],
            )
            for r in case["results"]
        ]
        scored = matching.score_candidates(
            case["title"], case["artist"], case["duration_s"], results
        )
        expected = case["expected"]["scored"]

        assert [c.url for c in scored] == [e["url"] for e in expected], case["name"]
        assert len(scored) == len(expected), case["name"]
        for candidate, entry in zip(scored, expected, strict=True):
            assert candidate.score == pytest.approx(entry["score"], abs=1e-12), case["name"]
            assert candidate.source == entry["source"], case["name"]

        best = scored[0].score if scored else None
        assert matching.classify(best).value == case["expected"]["status"], case["name"]


def test_search_query_matches(golden: dict) -> None:
    for case in golden["cases"]:
        assert (
            matching.build_search_query(case["title"], case["artist"]) == case["expected"]["query"]
        ), case["name"]
