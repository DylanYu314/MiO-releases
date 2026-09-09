# ADR-001: Local-first, server-optional architecture

## Status

Accepted — 2026-07-22

## Context

MiO is a music library manager with four features: link ingestion (F1), playlist
import (F2), a library manager (F3), and an optional cloud sync tier (F4). It needs
to work well as a single-user app running entirely on someone's own machine, but
also needs to support a "cloud mode" where a self-hosted server handles auth,
sync, and billing for the optional membership tier.

Building two separate codebases (one for local, one for cloud) would double the
maintenance burden for a solo project. We need one architecture that serves both.

We also need to decide, early, how the system is decomposed into services so that
downloads (which are slow — 30s to 5min) never block the API, and so that a web
client and an Android client can both be built against the same backend without
duplicating business logic.

## Decision

**One codebase, two deployment profiles.**

- The backend (FastAPI) is written against storage interfaces, not concrete
  databases/filesystems. In **local mode** it runs with SQLite and a local
  folder for files. In **cloud mode** the same code runs with PostgreSQL and
  S3-compatible object storage (MinIO locally, any S3 provider in production).
- The backend is API-first: the REST API (documented via OpenAPI) is the single
  contract that both the React web client and the React Native Android app
  consume. Neither client talks to the database or filesystem directly.
- Downloads (and other slow operations — transcoding, tagging, playlist
  matching) run as **async jobs**, never inline in a request/response cycle.
  Jobs move through explicit states (`queued → downloading → converting →
  tagging → done/failed`) and clients poll or subscribe (WebSocket) for
  progress rather than blocking on an HTTP call.
- Metadata and files are kept separate: the database stores song/playlist
  records and paths/URLs; audio bytes always live on disk or in object
  storage, never as DB blobs.

```
┌─────────────┐     ┌──────────────┐
│  Web client  │     │ Android app  │
│  (React)     │     │ (React Native│
│              │     │  or Kotlin)  │
└──────┬───────┘     └──────┬───────┘
       │      REST + WebSocket      │
       └──────────┬─────────────────┘
                  ▼
        ┌──────────────────┐
        │  Backend (FastAPI)│
        │  - Auth           │
        │  - Library API    │
        │  - Import service │
        │  - Job queue      │
        └───┬──────────┬───┘
            │          │
   ┌────────▼───┐  ┌───▼──────────────┐
   │ SQLite /   │  │ Worker process    │
   │ Postgres   │  │ yt-dlp + ffmpeg   │
   │ (metadata) │  │ (download jobs)   │
   └────────────┘  └───┬───────────────┘
                       ▼
              ┌────────────────┐
              │ File storage    │
              │ local folder →  │
              │ later: S3/MinIO │
              └────────────────┘
```

## Consequences

**Good:**

- A single mental model and codebase to maintain as a solo developer.
- The API-first boundary means the Android app (Phase 5) is "just another
  client" instead of a second implementation of core logic.
- Async jobs from day one avoid a painful later migration away from
  request-blocking downloads.
- Local mode has zero external dependencies (no Postgres/Redis/S3 to run),
  which keeps the inner dev loop fast during Phases 0–3.

**Trade-offs / risks:**

- Storage code must be written against an abstraction (e.g. a repository
  interface) from the start, which is a little more upfront design than
  hardcoding SQLite calls — worth it to avoid a rewrite in Phase 6.
- SQLite → Postgres and local-folder → S3 swaps still need to be verified
  explicitly (via config/tests), not just assumed to work.
- The job queue starts as FastAPI `BackgroundTasks` (Phase 1) and is expected
  to be replaced by Celery/arq + Redis in Phase 4 — that migration is deferred
  on purpose, see the tech stack ADR (ADR-002).

## Related

- ADR-002: Tech stack choices
- The original project plan: architecture and tech stack
