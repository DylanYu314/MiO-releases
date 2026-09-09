# ADR-004: In-process job event broker for live progress

## Status

**Superseded by [ADR-006](./0006-celery-redis-job-queue.md)** — accepted
2026-07-22, superseded 2026-07-23.

⚠️ The in-process broker described here worked, and was replaced for a reason
this document already anticipated: it cannot reach a client when the work runs
in a separate worker process. `app/events.py` is Redis pub/sub now. Kept because
the reasoning for the original choice is still the reasoning for not reaching
for a message broker on day one.

## Context

Phase 2 added live import progress to the web client. ADR-002
committed to running slow work as async jobs and pushing progress over
WebSocket rather than making clients poll.

This runs into a concurrency mismatch. The import pipeline
(`app/jobs.py`) runs **synchronously in a threadpool** — it is a normal
blocking function scheduled via FastAPI `BackgroundTasks` (ADR-001/ADR-002
deferred the move to Celery until Phase 4). WebSocket connections, on the
other hand, live on FastAPI's **asyncio event loop**. So the pipeline needs
to notify WebSocket clients across a thread boundary, and the obvious
primitive — `asyncio.Queue` — is not thread-safe.

We also don't yet have (or want) external infrastructure: the whole point of
Phases 1–3 is to run with no Redis/Postgres/broker to install.

## Decision

Introduce a small **in-process publish/subscribe broker** (`app/events.py`,
`JobEventBroker`, shared singleton `job_events`):

- A WebSocket handler `subscribe(job_id)`s and receives an `asyncio.Queue`
  of updates; it `unsubscribe`s on disconnect.
- The pipeline calls `publish(job_id, payload)` after each state transition.
  Because the caller is a worker thread, `publish` does **not** touch the
  queues directly — it hops back onto the event loop with
  `loop.call_soon_threadsafe(...)`, and the actual delivery runs on the loop.
  The loop reference is captured once at startup via FastAPI `lifespan`.
- **The database stays the source of truth.** `publish` runs *after* the
  transition is committed, and a WebSocket sends the job's current state on
  connect (read from the DB) before streaming further updates. A dropped or
  missed event therefore costs a client latency, never correctness — and
  `publish` with no loop bound (e.g. a unit test driving the pipeline
  directly) is a harmless no-op.

This is explicitly a **single-process** design. It works because the API
server and the `BackgroundTasks` worker share one process and one event loop.

## Consequences

**Good:**

- Live progress with zero new infrastructure — nothing extra to install or
  run in Phases 1–3, consistent with the local-first goal.
- The DB-as-source-of-truth rule means the WebSocket layer is a pure
  optimisation: the existing `GET /jobs/{id}` still returns correct state, and
  the client falls back to polling if the socket fails.
- The broker is a narrow, testable seam (fan-out, cross-thread publish, and
  unsubscribe are unit-tested without a running server).

**Trade-offs / risks:**

- **It does not survive the move to Celery (Phase 4).** Once jobs run in
  *separate worker processes*, an in-process singleton can't reach the
  process holding the WebSocket. At that point `publish` must become a real
  cross-process broker — Redis pub/sub is the intended replacement (Redis is
  already coming in Phase 4 for the Celery result/broker backend), keeping the
  same `subscribe`/`publish` shape so the WebSocket handler barely changes.
  This is called out in `app/events.py` where it will be read.
- It does not scale to multiple API processes/replicas either (same reason);
  that's a cloud-deployment concern (Phase 6) and shares the same fix.
- `call_soon_threadsafe` + per-subscriber `asyncio.Queue` is a little more
  machinery than a naive shared list, but it is the correct way to cross the
  thread/loop boundary and avoids subtle data races.

## Related

- ADR-001: Local-first, server-optional architecture (async jobs)
- ADR-002: Tech stack choices (`BackgroundTasks` now → Celery + Redis in Phase 4)
- ADR-003: Frontend architecture (polling first, WebSocket second)
- The original project plan: async jobs
