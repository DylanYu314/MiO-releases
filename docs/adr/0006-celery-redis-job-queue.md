# ADR-006: Celery + Redis for background work

## Status

Accepted — 2026-07-23

## Context

Since Phase 1, every slow operation — download, transcode, tag, search,
match — has run as a FastAPI `BackgroundTask`: a plain function handed to the
web server, executed in a threadpool inside the same process that serves HTTP.
ADR-002 chose that deliberately, as the simple mechanism to be replaced "once
its limits (no retries, no concurrency control) are actually felt."

Phase 3 made them felt. A single 130-track import exposed all four:

- **No concurrency control.** Work runs one item at a time because that is the
  only safe option; there is no way to say "three downloads at once, no more."
- **No durability.** Background tasks live and die with the web process. A
  restart mid-import loses the work silently — which is why Phase 3 had to add
  a startup sweep that marks interrupted imports as failed. That sweep treats
  a symptom the queue removes.
- **No retries.** 11 of 130 tracks failed with `HTTP 403: Forbidden` from
  YouTube — transient throttling — and stayed failed forever, with no way to
  try again short of re-importing the playlist.
- **No pacing.** Nothing throttles outbound work, which is what provoked that
  403 in the first place. MiO honours Spotify's `Retry-After` politely and
  then hammers YouTube as fast as it can.

There is also a structural debt to pay. ADR-004's in-process event broker works
only because the worker thread and the WebSocket share one process and one
event loop, and that ADR explicitly recorded that moving jobs into separate
processes breaks it, with Redis pub/sub as the intended replacement.

The plan named "Celery/arq + Redis" for this phase without settling which.

## Decision

**Celery 5 with Redis as both broker and result backend, plus Redis pub/sub for
progress events.**

### Why Celery over arq

arq is smaller, async-native and pleasant. It loses on the thing that matters
here: MiO's pipeline is **blocking synchronous code** — yt-dlp downloads and an
`ffmpeg` subprocess. arq's worker is a single asyncio event loop, so blocking
work must be pushed into an executor, giving up its main advantage while adding
a wrinkle to every task. Celery's default **prefork pool** runs each task in its
own OS process, which is exactly the right shape for blocking, CPU-and-IO-heavy
work, and gives real parallelism with a process count we choose.

Celery also ships, as configuration rather than code, the three things the live
import proved we need: **automatic retries with exponential backoff**,
**per-task rate limits**, and **acknowledgement semantics** that let a task
survive a worker dying. And as the de-facto standard Python task queue, it is
the more useful thing to have actually operated — this being a project whose
goals are explicitly part CV.

The costs are real and accepted: a heavier dependency, two more services to run,
another moving part to understand, and a worker that must be restarted to pick
up code changes.

### What changes

- **Tasks, not background functions.** `run_import_job`,
  `run_playlist_import` and `run_confirmed_import` keep their names and bodies
  and gain a Celery task wrapper. Routers stop calling
  `background_tasks.add_task(...)` and start calling `.delay(...)`, which
  writes a message to Redis and returns immediately. The pipeline logic itself
  is untouched — this is a change of *who runs the function*, not of what it
  does.
- **Progress crosses processes via Redis pub/sub.** `JobEventBroker` keeps its
  `subscribe`/`publish`/`unsubscribe` shape so WebSocket handlers barely
  change, but `publish` writes to a Redis channel and each API process
  subscribes to it. This is the replacement ADR-004 anticipated, and it also
  removes the single-API-process limitation for free.
- **The database stays the source of truth.** Unchanged from ADR-004: state is
  committed before it is published, WebSocket clients receive current state on
  connect, and a dropped event costs latency, never correctness. Nothing in
  this ADR makes the queue authoritative over the database.
- **Concurrency and pacing become policy, not accident.** A small worker pool
  (default 2 processes) with a per-task rate limit on downloads, so a large
  import proceeds briskly but does not look like a scraper. Downloads retry
  with exponential backoff and jitter on transient failures.
- **Local development gains a service.** `docker compose up` starts Redis, the
  API and a worker. Running the API alone remains possible for anything that
  does not enqueue work.
- **Tests stay offline.** The suite must keep running with no Redis and no
  broker: tasks are invoked as plain functions in unit tests, and the routers
  are tested with the enqueue call stubbed — the same seam already used for
  `BackgroundTasks`. A queue in CI would buy little and cost flakiness.

## Consequences

**Good:**

- Work survives an API restart, and a crashed worker's task can be retried
  rather than lost.
- Transient failures — the 403s — become recoverable automatically instead of
  permanently failed rows.
- Concurrency is a dial we set, not a property we're stuck with, and pacing
  makes MiO a better citizen of the sites it downloads from.
- The Phase 3 startup sweep becomes a safety net rather than the mechanism,
  and can eventually be removed.
- Redis, once present, is also the answer for cross-process progress and
  (later) any caching or locking cloud mode needs.

**Trade-offs / risks:**

- **Two extra services.** Anyone running MiO now needs Redis and a worker
  process, not just uvicorn. This is a genuine loss of the "zero external
  dependencies" property Phases 1–3 enjoyed, accepted because durability and
  retries are worth more from here on.
- **A new failure mode: the worker is down.** Enqueuing succeeds and nothing
  happens. The UI must be able to show "queued for a long time" rather than
  implying progress, and the operator needs a way to see worker health.
- **Debugging gets less direct.** A failure now happens in another process,
  which is precisely why structured logging is the next slice of this phase,
  not an afterthought.
- **Code changes need a worker restart** — an easy thing to forget, and it
  presents as "my fix did nothing."
- **Redis is not durable by default.** Losing it loses queued (not completed)
  work. Acceptable locally; a cloud deployment should enable persistence.
- SQLite tolerates a few concurrent writers poorly, so worker concurrency is
  deliberately small until Phase 6 brings Postgres.

## Related

- ADR-001: Local-first, server-optional architecture (async jobs)
- ADR-002: Tech stack choices (`BackgroundTasks` now → Celery + Redis later)
- ADR-004: In-process job event broker — names Redis pub/sub as its successor
- ADR-005: Spotify playlist import — the live run that made the limits concrete
- The original project plan, and the deferred retry and pacing follow-ups
