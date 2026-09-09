import base64
from pathlib import Path

from mutagen.flac import Picture
from mutagen.oggopus import OggOpus

IMAGE_MIME_TYPES = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "webp": "image/webp",
}


def image_mime_type(path: Path, default: str = "application/octet-stream") -> str:
    """Look up an image's MIME type by extension.

    Python's `mimetypes` module doesn't recognise `.webp` in the slim container
    image, and webp is exactly what yt-dlp downloads thumbnails as — so cover
    art needs an explicit lookup rather than letting the stdlib guess.
    """
    return IMAGE_MIME_TYPES.get(path.suffix.lower().lstrip("."), default)


class TaggingError(Exception):
    """Raised when mutagen fails to write tags to an Opus file."""


def write_tags(
    opus_path: Path,
    *,
    title: str,
    artist: str,
    album: str | None = None,
    cover_path: Path | None = None,
) -> None:
    try:
        audio = OggOpus(opus_path)
        audio["title"] = title
        audio["artist"] = artist
        if album:
            audio["album"] = album

        if cover_path is not None and cover_path.exists():
            picture = Picture()
            picture.data = cover_path.read_bytes()
            picture.type = 3
            picture.mime = image_mime_type(cover_path, default="image/jpeg")
            audio["metadata_block_picture"] = [base64.b64encode(picture.write()).decode("ascii")]

        audio.save()
    except Exception as exc:
        raise TaggingError(str(exc)) from exc
