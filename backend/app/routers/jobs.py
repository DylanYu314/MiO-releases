from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.access_keys import require_unlock_key
from app.db import SessionLocal, get_db
from app.events import job_events
from app.installs import current_owner, owned_by, require_install, resolve_install_id
from app.models import ImportJob, ImportStatus
from app.schemas import JobCreate, JobRead
from app.tasks import import_job_task

router = APIRouter(prefix="/jobs", tags=["jobs"])

TERMINAL_STATUSES = {ImportStatus.DONE, ImportStatus.FAILED}

# Sent when the requested job doesn't exist. 4000+ is the range reserved for
# application-defined WebSocket close codes.
WS_CLOSE_JOB_NOT_FOUND = 4004


@router.post("", response_model=JobRead, status_code=201)
def create_job(
    payload: JobCreate,
    db: Session = Depends(get_db),
    owner_install_id: int = Depends(require_install),
    _: None = Depends(require_unlock_key),
) -> ImportJob:
    """Download one link on the server.

    ⚠️ **Gated since #614, reversing ADR-009's original carve-out.**

    ADR-009 left this open deliberately: playlist import and search were locked,
    and "add a link" was the cheap, friendly path a keyless tester could still
    use. That reasoning has expired in both halves.

    - **It is no longer cheap relative to the rest.** Since #608 the phone
      fetches everything it can itself, so this is the *only* endpoint that
      still spends the server's CPU and bandwidth — yt-dlp plus an ffmpeg
      transcode, per request, from anyone who can reach the host.
    - **It is no longer one path among several.** A self-hosted MiO exists to
      serve this endpoint and almost nothing else, so leaving it open while
      telling self-hosters to "turn the access key on" would gate the two
      things their phone never asks for and leave the expensive one unguarded.

    The gate stays dormant until a key exists (or `REQUIRE_ACCESS_KEY=true`), so
    a personal instance with no keys is unaffected.
    """
    job = ImportJob(
        source_url=payload.url, status=ImportStatus.QUEUED, owner_install_id=owner_install_id
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    # Commit first: the worker may pick this up before .delay() even returns,
    # and it can only find the job if the row is already there.
    import_job_task.delay(job.id)
    return job


@router.get("/{job_id}", response_model=JobRead)
def get_job(
    job_id: int,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> ImportJob:
    job = db.scalar(
        select(ImportJob).where(ImportJob.id == job_id, owned_by(ImportJob, owner_install_id))
    )
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


def _read_job_payload(job_id: int, install: str | None) -> dict | None:
    """Fetch a job's current state as JSON, scoped to the caller's install.

    Uses its own short-lived session because a WebSocket outlives the
    request-scoped one from `Depends(get_db)`.

    ⚠️ **`install` is not optional and `None` must return nothing** (#514).
    Before this took an owner, the socket read the job by id alone while
    `GET /jobs/{job_id}` next to it scoped by `owned_by` — the same resource,
    two representations, one guarded. `JobRead` carries `source_url`, and ids
    are sequential integers, so anyone who could reach the server could
    enumerate them and read what was being downloaded.
    """
    db = SessionLocal()
    try:
        owner_install_id = resolve_install_id(db, install, create=False)
        job = db.scalar(
            select(ImportJob).where(ImportJob.id == job_id, owned_by(ImportJob, owner_install_id))
        )
        return JobRead.model_validate(job).model_dump(mode="json") if job else None
    finally:
        db.close()


@router.websocket("/{job_id}/ws")
async def job_progress(websocket: WebSocket, job_id: int, install: str | None = None) -> None:
    """Stream a job's state until it finishes.

    Replaces client-side polling: the client gets a message per transition
    instead of asking once a second.

    ⚠️ **The install id arrives as a query parameter, not a header** (#514).
    Browsers cannot set custom headers on a WebSocket handshake, so
    `X-Install-Id` — which every REST call uses — is not available here. A job
    that does not belong to the caller is indistinguishable from one that does
    not exist, which is deliberate: a different close code would confirm the id
    was real.
    """
    await websocket.accept()

    # Subscribe *before* reading current state. The other order leaves a gap in
    # which a transition could land between the read and the subscribe, and that
    # update would be lost. This way the worst case is a duplicate message,
    # which is harmless — each one carries the job's full state.
    queue = job_events.subscribe(job_id)
    try:
        payload = _read_job_payload(job_id, install)
        if payload is None:
            await websocket.close(code=WS_CLOSE_JOB_NOT_FOUND, reason="Job not found")
            return

        # Send current state immediately, so a client that connects late (or
        # reconnects) isn't left staring at nothing until the next transition.
        await websocket.send_json(payload)
        if payload["status"] in TERMINAL_STATUSES:
            await websocket.close()
            return

        while True:
            payload = await queue.get()
            await websocket.send_json(payload)
            if payload["status"] in TERMINAL_STATUSES:
                await websocket.close()
                return
    except WebSocketDisconnect:
        pass  # Client went away; nothing to clean up beyond unsubscribing.
    finally:
        job_events.unsubscribe(job_id, queue)
