from pathlib import Path

import pytest
from sqlalchemy.orm import Session

from app import jobs as jobs_module
from app.models import ImportJob, ImportStatus, Song
from app.ytdlp import ExtractedAudio, ExtractionError


def _create_job(db_session: Session, url: str = "https://example.com/watch?v=abc") -> int:
    job = ImportJob(source_url=url, status=ImportStatus.QUEUED)
    db_session.add(job)
    db_session.commit()
    return job.id


def _fake_extract_and_download(url: str, out_dir: Path) -> ExtractedAudio:
    out_dir.mkdir(parents=True, exist_ok=True)
    src = out_dir / "raw.webm"
    src.write_bytes(b"fake-raw-audio")
    thumb = out_dir / "raw.jpg"
    thumb.write_bytes(b"fake-thumbnail")
    return ExtractedAudio(
        file_path=src,
        title="Test Song",
        artist="Test Artist",
        album="Test Album",
        duration=123.4,
        thumbnail_path=thumb,
        source_platform="youtube",
    )


def _fake_to_opus(src_path: Path, dest_path: Path, bitrate: str = "160k") -> None:
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    dest_path.write_bytes(b"fake-opus-bytes")


def _fake_write_tags(opus_path: Path, **kwargs: object) -> None:
    pass


def test_happy_path_creates_song_and_marks_done(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(jobs_module, "extract_and_download", _fake_extract_and_download)
    monkeypatch.setattr(jobs_module, "to_opus", _fake_to_opus)
    monkeypatch.setattr(jobs_module, "write_tags", _fake_write_tags)

    job_id = _create_job(db_session)

    jobs_module.run_import_job(job_id)

    job = db_session.get(ImportJob, job_id)
    db_session.refresh(job)
    assert job.status == ImportStatus.DONE
    assert job.error is None
    assert job.song_id is not None

    song = db_session.get(Song, job.song_id)
    assert song.title == "Test Song"
    assert song.artist == "Test Artist"
    assert song.source_platform == "youtube"
    assert Path(song.file_path).exists()


@pytest.mark.parametrize(
    "error_message",
    [
        "Unsupported URL: not-a-real-url",
        "ERROR: [youtube] abc: Video unavailable. This video is not available in your country",
        "ERROR: Sign in to confirm your age",
    ],
    ids=["invalid_url", "geo_blocked", "age_gated"],
)
def test_extraction_failure_marks_job_failed(
    db_session: Session, monkeypatch: pytest.MonkeyPatch, error_message: str
) -> None:
    def _raise(url: str, out_dir: Path) -> ExtractedAudio:
        raise ExtractionError(error_message)

    monkeypatch.setattr(jobs_module, "extract_and_download", _raise)

    job_id = _create_job(db_session)

    jobs_module.run_import_job(job_id)

    job = db_session.get(ImportJob, job_id)
    db_session.refresh(job)
    assert job.status == ImportStatus.FAILED
    assert job.error == error_message
    assert job.song_id is None


def test_missing_job_is_a_noop(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs_module, "extract_and_download", _fake_extract_and_download)

    jobs_module.run_import_job(999999)

    assert db_session.query(Song).count() == 0


def test_records_loudness_on_the_song(db_session: Session, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.loudness import Loudness

    monkeypatch.setattr(jobs_module, "extract_and_download", _fake_extract_and_download)
    monkeypatch.setattr(jobs_module, "to_opus", _fake_to_opus)
    monkeypatch.setattr(jobs_module, "write_tags", _fake_write_tags)
    monkeypatch.setattr(
        jobs_module, "analyze_loudness", lambda _path: Loudness(lufs=-11.5, peak_dbfs=-0.7)
    )

    job_id = _create_job(db_session)
    jobs_module.run_import_job(job_id)

    song = db_session.get(Song, db_session.get(ImportJob, job_id).song_id)
    assert song.loudness_lufs == -11.5
    assert song.peak_dbfs == -0.7


def test_silent_file_is_stored_without_a_measurement(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(jobs_module, "extract_and_download", _fake_extract_and_download)
    monkeypatch.setattr(jobs_module, "to_opus", _fake_to_opus)
    monkeypatch.setattr(jobs_module, "write_tags", _fake_write_tags)
    monkeypatch.setattr(jobs_module, "analyze_loudness", lambda _path: None)

    job_id = _create_job(db_session)
    jobs_module.run_import_job(job_id)

    job = db_session.get(ImportJob, job_id)
    assert job.status == ImportStatus.DONE
    song = db_session.get(Song, job.song_id)
    assert song.loudness_lufs is None
    assert song.peak_dbfs is None


def test_loudness_failure_does_not_fail_the_import(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A missing measurement is a nicety lost, not a reason to lose the track."""
    from app.loudness import LoudnessError

    def _boom(_path):
        raise LoudnessError("ffmpeg exploded")

    monkeypatch.setattr(jobs_module, "extract_and_download", _fake_extract_and_download)
    monkeypatch.setattr(jobs_module, "to_opus", _fake_to_opus)
    monkeypatch.setattr(jobs_module, "write_tags", _fake_write_tags)
    monkeypatch.setattr(jobs_module, "analyze_loudness", _boom)

    job_id = _create_job(db_session)
    jobs_module.run_import_job(job_id)

    job = db_session.get(ImportJob, job_id)
    assert job.status == ImportStatus.DONE
    assert job.error is None
    song = db_session.get(Song, job.song_id)
    assert song.loudness_lufs is None
