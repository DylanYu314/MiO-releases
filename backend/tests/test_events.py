import asyncio
import json
import threading
from types import SimpleNamespace

import pytest
import redis

import app.events as events
from app.events import JobEventBroker, run_event_listener


@pytest.mark.asyncio
async def test_publish_reaches_every_subscriber_of_that_job() -> None:
    broker = JobEventBroker("mio:test")
    broker.bind_loop(asyncio.get_running_loop())
    first = broker.subscribe(1)
    second = broker.subscribe(1)
    other_job = broker.subscribe(2)

    broker.publish(1, {"status": "downloading"})
    await asyncio.sleep(0)  # let call_soon_threadsafe run

    assert first.get_nowait() == {"status": "downloading"}
    assert second.get_nowait() == {"status": "downloading"}
    assert other_job.empty()


@pytest.mark.asyncio
async def test_unsubscribe_stops_delivery_and_frees_the_slot() -> None:
    broker = JobEventBroker("mio:test")
    broker.bind_loop(asyncio.get_running_loop())
    queue = broker.subscribe(1)

    broker.unsubscribe(1, queue)
    broker.publish(1, {"status": "done"})
    await asyncio.sleep(0)

    assert queue.empty()
    assert broker.subscriber_count(1) == 0


@pytest.mark.asyncio
async def test_publish_from_a_worker_thread_is_delivered() -> None:
    """The import pipeline is sync and runs in a threadpool, so this is the
    path that actually matters in production."""
    broker = JobEventBroker("mio:test")
    broker.bind_loop(asyncio.get_running_loop())
    queue = broker.subscribe(1)

    thread = threading.Thread(target=broker.publish, args=(1, {"status": "tagging"}))
    thread.start()
    thread.join()

    assert await asyncio.wait_for(queue.get(), timeout=1) == {"status": "tagging"}


def test_publish_without_a_bound_loop_is_a_noop() -> None:
    """Unit tests drive the pipeline with no app running; publishing must not blow up."""
    broker = JobEventBroker("mio:test")

    broker.publish(1, {"status": "done"})  # must not raise

    assert broker.subscriber_count(1) == 0


@pytest.mark.asyncio
async def test_publish_to_a_job_with_no_subscribers_is_harmless() -> None:
    broker = JobEventBroker("mio:test")
    broker.bind_loop(asyncio.get_running_loop())

    broker.publish(999, {"status": "done"})
    await asyncio.sleep(0)

    assert broker.subscriber_count(999) == 0


# --------------------------------------------------------- Redis pub/sub


class FakeRedis:
    """Stands in for the synchronous publisher client."""

    def __init__(self, error: Exception | None = None) -> None:
        self.published: list[tuple[str, str]] = []
        self.error = error

    def publish(self, channel: str, message: str) -> None:
        if self.error is not None:
            raise self.error
        self.published.append((channel, message))


class FakePubSub:
    def __init__(self, messages: list[dict]) -> None:
        self.messages = messages
        self.subscribed: tuple[str, ...] = ()

    async def __aenter__(self) -> "FakePubSub":
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None

    async def subscribe(self, *channels: str) -> None:
        self.subscribed = channels

    async def listen(self):
        for message in self.messages:
            yield message
        await asyncio.Event().wait()  # then idle, like a real subscription


def test_publish_goes_to_redis_when_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """With a broker configured the event must leave the process — otherwise a
    worker's progress would never reach the API holding the WebSocket."""
    client = FakeRedis()
    monkeypatch.setattr(events, "_publisher_client", lambda: client)
    broker = JobEventBroker("mio:events:jobs")

    broker.publish(7, {"status": "downloading"})

    assert client.published == [
        ("mio:events:jobs", json.dumps({"id": 7, "payload": {"status": "downloading"}}))
    ]


@pytest.mark.asyncio
async def test_publish_falls_back_locally_when_redis_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = FakeRedis(error=redis.ConnectionError("no redis"))
    monkeypatch.setattr(events, "_publisher_client", lambda: client)
    broker = JobEventBroker("mio:test")
    broker.bind_loop(asyncio.get_running_loop())
    queue = broker.subscribe(1)

    broker.publish(1, {"status": "done"})  # must not raise
    await asyncio.sleep(0)

    assert queue.get_nowait() == {"status": "done"}


def test_no_publisher_client_without_a_redis_url() -> None:
    """conftest clears REDIS_URL, so the suite never talks to a real broker."""
    assert events._publisher_client() is None


@pytest.mark.asyncio
async def test_listener_dispatches_to_the_matching_broker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    jobs = JobEventBroker("mio:events:jobs")
    imports = JobEventBroker("mio:events:playlist-imports")
    for broker in (jobs, imports):
        broker.bind_loop(asyncio.get_running_loop())
    job_queue = jobs.subscribe(1)
    import_queue = imports.subscribe(1)

    pubsub = FakePubSub(
        [
            {"type": "subscribe", "channel": "mio:events:jobs", "data": 1},
            {
                "type": "message",
                "channel": "mio:events:playlist-imports",
                "data": json.dumps({"id": 1, "payload": {"status": "matching"}}),
            },
            # Same id on the other channel — must not cross over.
            {
                "type": "message",
                "channel": "mio:events:jobs",
                "data": json.dumps({"id": 1, "payload": {"status": "tagging"}}),
            },
            {"type": "message", "channel": "mio:events:jobs", "data": "not json"},
        ]
    )
    monkeypatch.setattr(events, "get_settings", lambda: SimpleNamespace(redis_url="redis://x"))
    monkeypatch.setattr(
        events.redis_async.Redis,
        "from_url",
        classmethod(lambda cls, *a, **k: SimpleNamespace(pubsub=lambda: pubsub)),
    )

    listener = asyncio.create_task(run_event_listener([jobs, imports]))
    try:
        assert await asyncio.wait_for(import_queue.get(), timeout=1) == {"status": "matching"}
        assert await asyncio.wait_for(job_queue.get(), timeout=1) == {"status": "tagging"}
        assert import_queue.empty()  # the jobs event didn't leak across
        assert pubsub.subscribed == ("mio:events:jobs", "mio:events:playlist-imports")
    finally:
        listener.cancel()


@pytest.mark.asyncio
async def test_listener_is_a_noop_without_redis() -> None:
    """Single-process mode: publish() delivers directly, so there's nothing to
    relay and the listener must return instead of retrying forever."""
    await asyncio.wait_for(run_event_listener([JobEventBroker("mio:test")]), timeout=1)
