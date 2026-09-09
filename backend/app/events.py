"""Fans job progress out to WebSocket clients, across processes.

Two boundaries have to be crossed. The pipeline runs synchronously (now in a
Celery worker *process*, previously a threadpool), while WebSocket connections
live on an API process's asyncio event loop — so an `asyncio.Queue` can never
be touched directly by the publisher.

`publish()` therefore writes to a **Redis channel** (ADR-006). Every API
process runs a listener that subscribes to those channels and hands incoming
messages to its local subscribers. The database remains the source of truth:
publishing happens after the state is committed, and a WebSocket sends current
state on connect, so a dropped event costs latency and never correctness.

With no Redis configured (the test suite, or a bare uvicorn run) `publish()`
falls back to delivering in-process, which is exactly the pre-ADR-006
behaviour and works because there is then only one process anyway.
"""

import asyncio
import json
import logging
from collections.abc import Sequence
from typing import Any

import redis
import redis.asyncio as redis_async

from app.config import get_settings

logger = logging.getLogger(__name__)

# How long to wait before reconnecting a dropped listener.
_LISTENER_RETRY_SECONDS = 2.0

_publisher: redis.Redis | None = None


def _publisher_client() -> redis.Redis | None:
    """The process-wide synchronous client used by publishers (workers).

    Created lazily: a Celery worker forks, and a connection made before the
    fork would be shared between processes.
    """
    global _publisher
    url = get_settings().redis_url
    if not url:
        return None
    if _publisher is None:
        _publisher = redis.Redis.from_url(url, decode_responses=True)
    return _publisher


class JobEventBroker:
    """Pub/sub for one kind of job, identified by a Redis channel name."""

    def __init__(self, channel: str) -> None:
        self.channel = channel
        self._subscribers: dict[int, set[asyncio.Queue[dict[str, Any]]]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Record the loop deliveries happen on. Called at startup."""
        self._loop = loop

    def subscribe(self, job_id: int) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers.setdefault(job_id, set()).add(queue)
        return queue

    def unsubscribe(self, job_id: int, queue: asyncio.Queue[dict[str, Any]]) -> None:
        subscribers = self._subscribers.get(job_id)
        if subscribers is None:
            return
        subscribers.discard(queue)
        # Drop the empty set so a long-running process doesn't accumulate one
        # entry per job it has ever seen.
        if not subscribers:
            del self._subscribers[job_id]

    def publish(self, job_id: int, payload: dict[str, Any]) -> None:
        """Deliver an update. Safe to call from any thread or process."""
        client = _publisher_client()
        if client is not None:
            try:
                client.publish(self.channel, json.dumps({"id": job_id, "payload": payload}))
                return
            except redis.RedisError as exc:
                # Best-effort by design: clients fall back to polling, and the
                # DB still holds the truth. Don't fail a job over a lost event.
                logger.warning("dropping progress event, redis publish failed: %s", exc)
        self._deliver_locally(job_id, payload)

    def _deliver_locally(self, job_id: int, payload: dict[str, Any]) -> None:
        """Single-process path: hop onto the event loop and deliver there."""
        loop = self._loop
        # No loop bound means no app is running (e.g. a unit test driving the
        # pipeline directly), so there is nobody to deliver to.
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self.dispatch, job_id, payload)

    def dispatch(self, job_id: int, payload: dict[str, Any]) -> None:
        """Hand a payload to this process's subscribers. Must run on the loop."""
        for queue in self._subscribers.get(job_id, set()):
            queue.put_nowait(payload)

    def subscriber_count(self, job_id: int) -> int:
        return len(self._subscribers.get(job_id, ()))


# One broker per kind of job. Separate instances (and channels) because both
# key on a bare integer id: sharing one would let ImportJob 7 and
# PlaylistImport 7 receive each other's updates.
job_events = JobEventBroker("mio:events:jobs")
playlist_import_events = JobEventBroker("mio:events:playlist-imports")


async def run_event_listener(brokers: Sequence[JobEventBroker]) -> None:
    """Relay Redis messages into the local brokers until cancelled.

    Runs for the lifetime of an API process (started from the lifespan
    handler). Reconnects on failure rather than giving up, since losing the
    listener downgrades clients to polling until it returns.
    """
    url = get_settings().redis_url
    if not url:
        return  # Single-process mode: publish() delivers directly.

    by_channel = {broker.channel: broker for broker in brokers}
    while True:
        try:
            client = redis_async.Redis.from_url(url, decode_responses=True)
            async with client.pubsub() as pubsub:
                await pubsub.subscribe(*by_channel)
                logger.info("listening for job events on %s", ", ".join(by_channel))
                async for message in pubsub.listen():
                    if message["type"] != "message":
                        continue
                    broker = by_channel.get(message["channel"])
                    if broker is None:
                        continue
                    try:
                        event = json.loads(message["data"])
                        broker.dispatch(event["id"], event["payload"])
                    except (ValueError, KeyError):
                        logger.warning("ignoring malformed job event on %s", message["channel"])
        except asyncio.CancelledError:
            raise  # Shutdown, not a failure.
        except Exception as exc:
            logger.warning("job event listener lost, reconnecting: %s", exc)
            await asyncio.sleep(_LISTENER_RETRY_SECONDS)
