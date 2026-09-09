"""Crash reports from the clients (P9, #136).

The pilot tester is non-technical and phone-first, so "find the log and send it
to me" is not a plan. The clients report their own failures instead.

**Ungated on purpose.** `POST` requires no access key and no install id. A client
that crashes during setup — before it has either — is exactly the case worth
hearing about, and a gate would silently drop those reports. The install id is
recorded when there is one, so several reports from one device can be tied
together while a bug is being chased.

The cost of an open endpoint is that anyone who finds it can write rows to it.
That is accepted here: the payload is size-capped by the schema, the rows carry
nothing sensitive, and this is an invite-only pilot rather than a public service.
If it is ever abused, rate-limiting belongs at Caddy rather than in here.
"""

import logging
from datetime import timedelta

from fastapi import APIRouter, Depends, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.access_keys import require_admin_key
from app.config import get_settings
from app.db import SessionLocal, get_db
from app.installs import current_owner
from app.models import ClientError, _utcnow
from app.schemas import (
    ClientErrorBatch,
    ClientErrorBatchResult,
    ClientErrorCreate,
    ClientErrorRead,
    Page,
)

router = APIRouter(prefix="/client-errors", tags=["client-errors"])

logger = logging.getLogger(__name__)


def purge_expired(db: Session) -> int:
    """Drop rows older than the retention window, returning how many went.

    Called from the app's startup and after each batch upload rather than from a
    scheduled job: those are the two moments a row arrives, and a table nobody
    is writing to does not need sweeping. It deliberately does not commit — the
    caller's transaction owns that, so a sweep can never half-apply next to the
    write it accompanies.
    """
    days = get_settings().client_error_retention_days
    if days <= 0:
        return 0
    cutoff = _utcnow() - timedelta(days=days)
    result = db.execute(delete(ClientError).where(ClientError.created_at < cutoff))
    return result.rowcount or 0


def purge_expired_on_startup() -> int:
    """The same sweep, on its own session, for the app's boot.

    Without this a server nobody has uploaded to for months would never sweep,
    because the only other trigger is an upload arriving. Cheap: one indexed
    delete against a table that is small by construction.
    """
    db = SessionLocal()
    try:
        purged = purge_expired(db)
        db.commit()
        if purged:
            logger.info("purged expired client errors", extra={"client_log_purged": purged})
        return purged
    finally:
        db.close()


@router.post("", response_model=ClientErrorRead, status_code=status.HTTP_201_CREATED)
def report_client_error(
    payload: ClientErrorCreate,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> ClientError:
    report = ClientError(
        platform=payload.platform,
        message=payload.message,
        stack=payload.stack,
        description=payload.description,
        app_version=payload.app_version,
        os_version=payload.os_version,
        device=payload.device,
        level=payload.level,
        client_key=payload.client_key,
        owner_install_id=owner_install_id,
    )
    db.add(report)
    db.commit()
    db.refresh(report)

    # Also into the server's own JSON logs, so a report shows up in the same
    # place as everything else rather than only in a table someone has to know
    # to query.
    logger.warning(
        "client error reported",
        extra={
            "client_platform": payload.platform,
            "client_error_id": report.id,
            "app_version": payload.app_version,
        },
    )
    return report


@router.post(
    "/batch",
    response_model=ClientErrorBatchResult,
    status_code=status.HTTP_200_OK,
)
def report_client_error_batch(
    payload: ClientErrorBatch,
    db: Session = Depends(get_db),
    owner_install_id: int | None = Depends(current_owner),
) -> ClientErrorBatchResult:
    """A device's rolling log, uploaded in one request (#322).

    **200 rather than 201**, because the honest answer is "some of this was
    already here": a batch that is entirely duplicates created nothing, and the
    device is meant to treat that as success rather than as a reason to keep
    retrying forever.

    Dedupe is done by reading the keys already present and skipping them, not by
    catching an IntegrityError. That is deliberate: one conflicting row inside a
    flush aborts the whole transaction on SQLite, so the exception-driven
    version loses the 499 good entries that shared the request with a repeat.

    A concurrent upload of the same keys could still slip past the read — two
    uploads from one device at the same instant. The UNIQUE index is what makes
    that a rejected request rather than a duplicated row, and the device simply
    sends again; a lock held across an ungated endpoint would be the worse
    trade.
    """
    keys = {item.client_key for item in payload.items if item.client_key is not None}
    already: set[str] = set()
    if keys:
        already = set(
            db.scalars(select(ClientError.client_key).where(ClientError.client_key.in_(keys))).all()
        )

    stored = 0
    duplicates = 0
    for item in payload.items:
        if item.client_key is not None and item.client_key in already:
            duplicates += 1
            continue
        # Guards a batch that repeats a key *within itself*, which the read
        # above cannot see and the UNIQUE index would reject at flush.
        if item.client_key is not None:
            already.add(item.client_key)
        db.add(
            ClientError(
                platform=item.platform,
                message=item.message,
                stack=item.stack,
                description=item.description,
                app_version=item.app_version,
                os_version=item.os_version,
                device=item.device,
                level=item.level,
                client_key=item.client_key,
                owner_install_id=owner_install_id,
            )
        )
        stored += 1

    purged = purge_expired(db)
    db.commit()

    logger.info(
        "client log batch received",
        extra={
            "client_platform": payload.items[0].platform,
            "client_log_stored": stored,
            "client_log_duplicates": duplicates,
            "client_log_purged": purged,
        },
    )
    return ClientErrorBatchResult(stored=stored, duplicates=duplicates)


@router.get("", response_model=Page[ClientErrorRead])
def list_client_errors(
    limit: int = 50,
    offset: int = 0,
    level: str | None = None,
    install: int | None = None,
    db: Session = Depends(get_db),
    _: None = Depends(require_admin_key),
) -> Page[ClientErrorRead]:
    """Newest first — this is read by a person looking for what just broke.

    **Admin-gated, unlike the two writes above (#354).** Reporting and reading are
    different acts. A client must always be able to report — it may be crashing
    during setup, before it has any credential, and that is the report most worth
    having. Reading is the developer's view of *everyone's* reports: stack
    traces, whatever users typed into "what were you doing", and since #322 a
    daily log from every device.

    It was open from #136 until #354, and `mio.dlany.uk/api/client-errors`
    answered in full to anyone who asked. That was survivable while the table
    held crashes from one tester and stopped being so the moment it held a log
    from every install.

    **`require_admin_key`, not `require_unlock_key`.** The first fix used the
    latter and was barely a fix: every invited tester holds an ordinary key, so
    it would have let any of them read all the others' reports. I caught it
    — *"unlock key wont protect it, any user with it can still access it, not
    only me have it"* — before it merged.

    `level` narrows to one severity. It matters more since #322 than it would
    have before: a day of one phone's log buries the three crashes in it under a
    few hundred routine lines, and "show me only the errors" is the first thing
    anyone reading this asks for. `install` narrows to one device, which is the
    second thing.
    """
    limit = max(1, min(limit, 200))
    filters = []
    if level:
        filters.append(ClientError.level == level)
    if install is not None:
        # "Show me only this tester" — the question a developer asks second,
        # right after "what broke". Without it a busy day from one device
        # buries everyone else.
        filters.append(ClientError.owner_install_id == install)
    total = db.scalar(select(func.count()).select_from(ClientError).where(*filters)) or 0
    rows = db.scalars(
        # `id` breaks the tie, and it is not decoration: reports arriving in the
        # same instant is the *normal* case — a crashing client sends a burst —
        # and ordering on the timestamp alone leaves those rows in an arbitrary
        # order, so a paginated read can show one twice and miss another.
        select(ClientError)
        .where(*filters)
        .order_by(ClientError.created_at.desc(), ClientError.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return Page[ClientErrorRead](
        items=[ClientErrorRead.model_validate(row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )
