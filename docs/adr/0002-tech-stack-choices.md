# ADR-002: Tech stack choices

## Status

Accepted — 2026-07-22

## Context

This is a learning project as much as a product: the goals are (1) a working
music library manager, (2) hands-on practice with industry-standard tooling,
and (3) a defensible CV story. The stack needs to support the architecture in
ADR-001 (local-first, server-optional, API-first, async jobs) while keeping
the learning curve sequenced — simple tools first, "industrial" replacements
introduced later once the simple version is understood.

## Decision

| Layer | Choice | Reasoning |
|---|---|---|
| Backend | Python 3.12 + FastAPI | Async-native, auto-generates OpenAPI (needed for API-first clients), widely used in industry |
| Download engine | yt-dlp + ffmpeg | De-facto standard; supports YouTube, Bilibili, Douyin, TikTok, Instagram and 1000+ sites |
| Metadata tagging | mutagen | Standard Python audio-tagging library |
| Database | SQLite (local) → PostgreSQL (cloud), via SQLAlchemy 2.0 + Alembic | Teaches ORM + migrations; the swap exercises the storage abstraction from ADR-001 |
| Job queue | FastAPI `BackgroundTasks` now → Celery/arq + Redis in Phase 4 | Learn the simple mechanism first, replace it once its limits (no retries, no concurrency control) are actually felt |
| Web frontend | React + TypeScript + Vite, TanStack Query, Zustand | React+TS is the strongest job-market signal; TanStack Query teaches server-state vs UI-state separation |
| Audio playback (web) | HTML5 `<audio>` + Media Session API | Native browser support, gets lock-screen/media-key controls for free |
| Android | React Native (Expo), decided at Phase 5 | Reuses React/TS knowledge; API-first design means Kotlin is still an option later without backend changes |
| Cloud storage | MinIO locally (S3-compatible) → any S3 provider | Learn the S3 API without a cloud bill during development |
| Auth | JWT (access + refresh) via FastAPI; OAuth2 (Authorization Code + PKCE) for Spotify/Google | Industry-standard patterns for both first-party and third-party auth |
| Payments | Stripe test mode | Real integration experience, zero real transactions |
| Deployment | Docker + docker-compose; VPS (Hetzner/Oracle free tier) + Caddy for HTTPS | Docker is baseline industry knowledge; Caddy keeps TLS config trivial |
| CI/CD | GitHub Actions: lint + type-check + test on every PR; build image on merge to `main` | Standard CI gate; kept in Phase 0 so every later PR is checked from day one |
| Testing | pytest (backend), Vitest + React Testing Library (frontend), Playwright (a few e2e) | Matches ecosystem defaults for each language |
| Lint/format | ruff (Python), ESLint + Prettier (TS), pre-commit hooks | Fast, low-config, catches issues before CI |
| Licence | AGPL-3.0 | Real OSI licence with network-use copyleft — appropriate given the project touches media ingestion; still fully creditable as open source on a CV |

## Consequences

**Good:**

- Every "simple now, industrial later" pair (BackgroundTasks→Celery, SQLite→Postgres,
  local folder→S3) is a deliberate, named learning milestone rather than
  accidental scope creep.
- Picking React for both web and (initially) Android means one language/ecosystem
  to hold in your head across Phases 2–5.
- FastAPI's OpenAPI generation gives the web and Android clients a typed contract
  for free, reducing drift between client and server.

**Trade-offs / risks:**

- React Native is chosen over Kotlin for Phase 5 to save learning time; if
  "real Android dev" experience becomes a priority later, the API-first
  boundary makes swapping to Kotlin + Jetpack Compose possible without
  touching the backend.
- AGPL-3.0 is a strong copyleft licence — anyone deploying a modified version
  as a network service must also release their source. This is intentional
  (see the project's ground rules: non-commercial, personal-use framing) but
  should be understood before accepting outside contributions.
- Introducing Celery/Redis and Postgres/S3 later (Phases 4 and 6) means the
  storage/queue abstractions from ADR-001 must actually be respected in Phases
  1–3, or the later swap will require rework.

## Related

- ADR-001: Local-first, server-optional architecture
- The original project plan: tech stack and roadmap
