"""Parsing of ffmpeg's EBU R128 summary.

The sample outputs below are copied from a real ffmpeg 7.1.5 run against a
library file, not invented — the parser's whole job is to survive that exact
format.
"""

import subprocess
from pathlib import Path

import pytest

from app.loudness import Loudness, LoudnessError, analyze

REAL_SUMMARY = """[Parsed_ebur128_0 @ 0x7a392c004600] Summary:

  Integrated loudness:
    I:         -16.8 LUFS
    Threshold: -27.0 LUFS

  Loudness range:
    LRA:         1.9 LU
    Threshold: -37.0 LUFS
    LRA low:   -18.1 LUFS
    LRA high:  -16.2 LUFS

  True peak:
    Peak:       -1.1 dBFS
"""

# What the filter emits without framelog=quiet: an `I:` field appears inline on
# every 100ms progress line, which must not be mistaken for the summary.
WITH_FRAME_LOG = (
    "[Parsed_ebur128_0 @ 0x1] t: 1.0 TARGET:-23 LUFS    M: -80.5 S: -62.2     "
    "I: -99.9 LUFS       LRA:   1.9 LU  FTPK: -75.8 -76.4 dBFS  TPK:  -9.9  -9.9 dBFS\n"
) + REAL_SUMMARY


def _run(monkeypatch, stderr: str, returncode: int = 0):
    def fake_run(*_args, **_kwargs):
        if returncode != 0:
            raise subprocess.CalledProcessError(returncode, "ffmpeg", stderr=stderr.encode())
        return subprocess.CompletedProcess([], 0, stdout=b"", stderr=stderr.encode())

    monkeypatch.setattr(subprocess, "run", fake_run)


def test_parses_integrated_loudness_and_true_peak(monkeypatch):
    _run(monkeypatch, REAL_SUMMARY)

    result = analyze(Path("song.opus"))

    assert result == Loudness(lufs=-16.8, peak_dbfs=-1.1)


def test_ignores_the_per_frame_progress_lines(monkeypatch):
    # The frame lines carry their own `I:` and `TPK:` values; picking those up
    # would produce a wildly wrong gain.
    _run(monkeypatch, WITH_FRAME_LOG)

    result = analyze(Path("song.opus"))

    assert result == Loudness(lufs=-16.8, peak_dbfs=-1.1)


def test_silence_has_no_usable_level(monkeypatch):
    _run(
        monkeypatch,
        "  Integrated loudness:\n    I:         -inf LUFS\n\n"
        "  True peak:\n    Peak:      -inf dBFS\n",
    )

    assert analyze(Path("silent.opus")) is None


def test_near_silence_is_treated_as_silence(monkeypatch):
    # A gain computed from -90 LUFS would be enormous; there is nothing there
    # worth lifting.
    _run(
        monkeypatch,
        "  Integrated loudness:\n    I:         -91.2 LUFS\n\n"
        "  True peak:\n    Peak:      -80.0 dBFS\n",
    )

    assert analyze(Path("almost-silent.opus")) is None


def test_missing_peak_assumes_the_worst(monkeypatch):
    # Without a peak the clipping guard has nothing to work with, so 0 dBFS is
    # assumed rather than risking an overshoot.
    _run(monkeypatch, "  Integrated loudness:\n    I:         -14.0 LUFS\n")

    result = analyze(Path("song.opus"))

    assert result == Loudness(lufs=-14.0, peak_dbfs=0.0)


def test_unparseable_output_is_not_a_measurement(monkeypatch):
    _run(monkeypatch, "something went sideways but exited zero")

    assert analyze(Path("song.opus")) is None


def test_ffmpeg_failure_raises(monkeypatch):
    _run(monkeypatch, "Invalid data found when processing input", returncode=1)

    with pytest.raises(LoudnessError, match="Invalid data"):
        analyze(Path("broken.opus"))


def test_missing_ffmpeg_raises(monkeypatch):
    def boom(*_args, **_kwargs):
        raise FileNotFoundError("ffmpeg")

    monkeypatch.setattr(subprocess, "run", boom)

    with pytest.raises(LoudnessError):
        analyze(Path("song.opus"))


def test_uses_quiet_framelog_so_output_stays_small(monkeypatch):
    # A long track emits one progress line per 100ms; capturing thousands of
    # them just to discard them is waste the filter can avoid.
    captured: dict[str, list[str]] = {}

    def fake_run(args, **_kwargs):
        captured["args"] = args
        return subprocess.CompletedProcess([], 0, stdout=b"", stderr=REAL_SUMMARY.encode())

    monkeypatch.setattr(subprocess, "run", fake_run)
    analyze(Path("song.opus"))

    assert "ebur128=peak=true:framelog=quiet" in captured["args"]
