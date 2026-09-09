"""Loudness analysis via ffmpeg's EBU R128 filter.

A thin wrapper with its own exception type, the same shape as `transcode.py`
and `tagging.py` — which is what keeps the pipeline mockable in tests.

Measurement happens once, at import. Playback correction is a gain applied in
the browser's audio graph (ADR-012), so the stored files are never rewritten:
the analysis is metadata *about* the audio, not a change *to* it. That means a
different target loudness later is a settings change, not a re-encode of the
whole library.
"""

import logging
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)


class LoudnessError(Exception):
    """Raised when ffmpeg fails to analyse a file's loudness."""


@dataclass(frozen=True)
class Loudness:
    """Integrated loudness and true peak, both in their conventional units."""

    lufs: float
    peak_dbfs: float


# The summary block ffmpeg prints at the end looks like:
#
#       Integrated loudness:
#         I:         -16.8 LUFS
#         Threshold: -27.0 LUFS
#       ...
#       True peak:
#         Peak:       -1.1 dBFS
#
# Anchored to line starts so the per-frame progress lines — which also carry an
# `I:` field, inline — cannot match.
_INTEGRATED_RE = re.compile(r"^\s*I:\s+(-?[\d.]+|-inf)\s+LUFS\s*$", re.MULTILINE)
_TRUE_PEAK_RE = re.compile(r"^\s*Peak:\s+(-?[\d.]+|-inf)\s+dBFS\s*$", re.MULTILINE)

# Analysis of a silent or near-silent file reports -inf (or an absurdly low
# number). There is nothing to normalise there, and a gain computed from it
# would be enormous.
_SILENCE_FLOOR_LUFS = -70.0


def _parse(pattern: re.Pattern[str], output: str) -> float | None:
    match = pattern.search(output)
    if match is None:
        return None
    value = match.group(1)
    if value == "-inf":
        return None
    try:
        return float(value)
    except ValueError:  # pragma: no cover - the regex already constrains this
        return None


def analyze(path: Path) -> Loudness | None:
    """Measure `path`, or return None when there is nothing meaningful to measure.

    None means "analysed, found no usable level" — a silent file — and is
    recorded as such so the track isn't re-analysed on every pass.
    """
    try:
        completed = subprocess.run(
            [
                "ffmpeg",
                "-nostats",
                "-hide_banner",
                "-i",
                str(path),
                "-map",
                "0:a",
                # framelog=quiet drops the per-100ms progress lines; without it
                # a long track emits thousands of lines to be captured and
                # thrown away.
                "-af",
                "ebur128=peak=true:framelog=quiet",
                "-f",
                "null",
                "-",
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode(errors="replace") if exc.stderr else str(exc)
        raise LoudnessError(stderr) from exc
    except FileNotFoundError as exc:  # ffmpeg missing entirely
        raise LoudnessError(str(exc)) from exc

    # ebur128 reports on stderr, like everything else ffmpeg says about itself.
    output = completed.stderr.decode(errors="replace")
    lufs = _parse(_INTEGRATED_RE, output)
    peak = _parse(_TRUE_PEAK_RE, output)

    if lufs is None or lufs <= _SILENCE_FLOOR_LUFS:
        logger.info("no usable loudness measured", extra={"path": str(path)})
        return None
    if peak is None:
        # Loudness without a peak is still useful, but the clipping guard needs
        # a number; assume the worst rather than risk overshooting.
        peak = 0.0

    return Loudness(lufs=lufs, peak_dbfs=peak)
