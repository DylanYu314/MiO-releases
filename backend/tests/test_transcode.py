"""Skipping the re-encode when the source is already Opus (#157).

These assert the *decision* — which ffmpeg command is built — because that is
the part with branching logic. Whether the resulting file is valid was checked
against real ffmpeg, mutagen and ebur128 rather than mocked; see the PR and the
`to_opus` docstring.
"""

import subprocess
from pathlib import Path

import pytest

from app import transcode
from app.transcode import TranscodeError, audio_codec, to_opus


def _run_recorder(monkeypatch: pytest.MonkeyPatch, *, codec: str | None) -> list[list[str]]:
    """Capture the ffmpeg/ffprobe commands `to_opus` would run."""
    commands: list[list[str]] = []

    class Result:
        stdout = (codec or "").encode()
        stderr = b""

    def fake_run(cmd, **_kwargs):
        commands.append(cmd)
        if cmd[0] == "ffprobe" and codec is None:
            raise subprocess.CalledProcessError(1, cmd, stderr=b"probe failed")
        return Result()

    monkeypatch.setattr(transcode.subprocess, "run", fake_run)
    return commands


def _ffmpeg_command(commands: list[list[str]]) -> list[str]:
    return next(cmd for cmd in commands if cmd[0] == "ffmpeg")


def test_an_opus_source_is_copied_not_re_encoded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The common case: yt-dlp's `bestaudio` on YouTube is usually already Opus.
    Re-encoding it is a second lossy generation for no gain, and it is the
    slowest step in the pipeline."""
    commands = _run_recorder(monkeypatch, codec="opus")

    to_opus(tmp_path / "in.webm", tmp_path / "out.opus")

    ffmpeg = _ffmpeg_command(commands)
    assert "-c:a" in ffmpeg and ffmpeg[ffmpeg.index("-c:a") + 1] == "copy"
    assert "libopus" not in ffmpeg
    assert "-b:a" not in ffmpeg


def test_a_non_opus_source_is_still_transcoded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    commands = _run_recorder(monkeypatch, codec="aac")

    to_opus(tmp_path / "in.m4a", tmp_path / "out.opus", bitrate="160k")

    ffmpeg = _ffmpeg_command(commands)
    assert ffmpeg[ffmpeg.index("-c:a") + 1] == "libopus"
    assert ffmpeg[ffmpeg.index("-b:a") + 1] == "160k"


def test_an_unprobeable_source_falls_back_to_transcoding(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A probe failure must not fail the import. Re-encoding always works, so
    the safe answer to "I don't know" is to do what we always did."""
    commands = _run_recorder(monkeypatch, codec=None)

    to_opus(tmp_path / "in.weird", tmp_path / "out.opus")

    assert _ffmpeg_command(commands)[_ffmpeg_command(commands).index("-c:a") + 1] == "libopus"


def test_the_video_stream_is_dropped_on_both_paths(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """yt-dlp can embed cover art as a video stream, and the Ogg muxer refuses
    one. Losing `-vn` from the copy path would fail only for files that happen
    to carry artwork."""
    for codec in ("opus", "aac"):
        commands = _run_recorder(monkeypatch, codec=codec)
        to_opus(tmp_path / "in", tmp_path / "out.opus")
        assert "-vn" in _ffmpeg_command(commands), codec


def test_ffmpeg_failure_still_raises_transcode_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fake_run(cmd, **_kwargs):
        if cmd[0] == "ffprobe":

            class Result:
                stdout = b"opus"

            return Result()
        raise subprocess.CalledProcessError(1, cmd, stderr=b"ffmpeg exploded")

    monkeypatch.setattr(transcode.subprocess, "run", fake_run)

    with pytest.raises(TranscodeError, match="ffmpeg exploded"):
        to_opus(tmp_path / "in.webm", tmp_path / "out.opus")


def test_a_missing_ffprobe_does_not_crash_the_import(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`transcode` deliberately does not catch FileNotFoundError around ffmpeg
    itself, but the probe is an optimisation and must degrade quietly."""

    def fake_run(cmd, **_kwargs):
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(transcode.subprocess, "run", fake_run)

    assert audio_codec(tmp_path / "anything") is None


def test_an_empty_probe_result_reads_as_unknown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """ffprobe exits 0 with no output for a file that has no audio stream.
    Empty must not be mistaken for a codec name."""

    class Result:
        stdout = b"\n"

    monkeypatch.setattr(transcode.subprocess, "run", lambda *a, **k: Result())

    assert audio_codec(tmp_path / "silent.mp4") is None
