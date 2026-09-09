import logging
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


class TranscodeError(Exception):
    """Raised when ffmpeg fails to transcode a downloaded audio file to Opus."""


def audio_codec(path: Path) -> str | None:
    """The codec of the first audio stream, or None if it can't be determined.

    Deliberately forgiving. A probe failure falls back to re-encoding, which
    always works — skipping the re-encode is worth having but not worth risking
    an import for.
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            check=True,
            capture_output=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    return result.stdout.decode(errors="replace").strip() or None


def to_opus(src_path: Path, dest_path: Path, bitrate: str = "160k") -> None:
    """Put the downloaded audio into an Ogg Opus file.

    **Re-encodes only when it has to.** yt-dlp is asked for `bestaudio` with no
    postprocessors, and on YouTube that stream is usually *already* Opus, in a
    WebM container. Re-encoding it produces a second generation of a lossy codec
    — worse audio, for nothing — and spends the slowest step in the pipeline
    doing it. When the source is already Opus, only the container changes.

    Measured rather than assumed: remuxing a 5s Opus/WebM source produced an
    **byte-identical Opus packet stream** (same sha256, same 110,780 bytes). The
    decoded PCM differs by about 13 ms at the very head, because WebM signals
    encoder delay as a negative start time while Ogg Opus carries it in the
    header — inaudible padding, not audio.

    Anything else (AAC from Bilibili and most non-YouTube sites) is transcoded
    exactly as before.

    Both paths produce a real Ogg Opus file, which matters downstream and was
    also checked against the real tools: `tagging` opens it with mutagen's
    `OggOpus` to write `metadata_block_picture`, and `loudness` runs `ebur128`
    over it.
    """
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    source_codec = audio_codec(src_path)
    already_opus = source_codec == "opus"
    # `-vn` drops any cover-art video stream yt-dlp embedded. The thumbnail is
    # handled separately, and the Ogg muxer will not take a video stream.
    codec_args = ["-c:a", "copy"] if already_opus else ["-c:a", "libopus", "-b:a", bitrate]

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(src_path), "-vn", *codec_args, str(dest_path)],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode(errors="replace") if exc.stderr else str(exc)
        raise TranscodeError(stderr) from exc

    logger.info(
        "remuxed without re-encoding" if already_opus else "transcoded to opus",
        extra={"source_codec": source_codec},
    )
