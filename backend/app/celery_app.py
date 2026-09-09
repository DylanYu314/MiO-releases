"""The Celery application — the thing that turns functions into queued work.

Configured from `REDIS_URL` (ADR-006). With no Redis configured the app falls
back to running tasks *eagerly* (inline, in the caller), which keeps the test
suite and a bare `uvicorn` run working without a broker.
"""

from celery import Celery
from celery.signals import setup_logging

from app.config import get_settings
from app.logging_config import configure_logging


@setup_logging.connect
def _use_our_logging(**kwargs: object) -> None:
    """Celery installs its own handlers unless this signal is connected, which
    would drop our JSON format and the job-id context with it."""
    configure_logging()


settings = get_settings()
_broker_url = settings.redis_url or "memory://"

celery_app = Celery("mio", broker=_broker_url, backend=settings.redis_url or None)

celery_app.conf.update(
    # No broker configured: run tasks inline rather than dropping them.
    task_always_eager=not settings.redis_url,
    task_eager_propagates=True,
    # Acknowledge only once the task finishes, so a worker killed mid-download
    # leaves the message on the queue to be retried instead of losing it.
    task_acks_late=True,
    # Our tasks are minutes long, so a worker hoarding queued messages would
    # stall everything behind it. One at a time.
    worker_prefetch_multiplier=1,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    # Where the task functions live, so the worker registers them at startup.
    imports=("app.tasks",),
)
