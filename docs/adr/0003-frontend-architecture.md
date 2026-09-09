# ADR-003: Frontend architecture and tooling

## Status

Accepted — 2026-07-22

## Context

ADR-002 picked React + TypeScript + Vite, TanStack Query and Zustand for the web
client, but it settled the *stack* rather than the *architecture*. Building the
first web client in Phase 2 forced several decisions that ADR-002 doesn't cover:
how the UI is styled, how the browser reaches the backend during development,
how the API contract is kept in sync between the two codebases, and how job
progress is delivered before the WebSocket work lands.

Two of these came up because the ground moved. The Vite React+TS template now
ships **oxlint** rather than ESLint, and Tailwind v4 replaced its JavaScript
config file with a CSS-first setup — so "follow the template defaults" is no
longer the same thing as "follow ADR-002".

## Decision

**Styling: Tailwind CSS (v4).** Utility classes in the markup, with the CSS-first
setup (`@import 'tailwindcss'` plus the `@tailwindcss/vite` plugin) — no
`tailwind.config.js`. Chosen over plain CSS Modules for speed of iteration and
because it is currently the most common styling approach in industry, which
matters for a project whose goal is partly employability.

**Linting: ESLint + Prettier, not the template's oxlint.** ADR-002 committed to
ESLint + Prettier. oxlint is genuinely faster and is philosophically the JS
equivalent of `ruff` (which this project already uses for Python), but ESLint is
far more widely used, and "the template default changed" is not a strong enough
reason to silently deviate from a recorded decision. ESLint's
`react-hooks` rules also caught a real bug during Phase 2 (a `setState` inside an
effect causing a redundant render pass).

**Server state: TanStack Query; UI state: React's own hooks.** Anything that
lives on the server (songs, playlists, jobs) is owned by TanStack Query, which
handles caching, refetching and invalidation. Local UI state (search text, the
current sort, pagination offset) stays in `useState`. Zustand is deferred until
the audio player actually needs cross-component state — installing it before
then would violate this project's "only add what's used" rule.

**Job progress: polling first, WebSocket second.** The job hook polls
`GET /jobs/{id}` once a second and stops once the job reaches `done` or `failed`.
This mirrors the deliberate `BackgroundTasks → Celery` progression in ADR-002:
build the simple mechanism, feel its limits, then replace it.

**Development transport: Vite proxy, not CORS.** The dev server forwards
`/api/*` to the backend on port 8000, so the browser only ever sees a single
origin. The backend therefore needs no CORS middleware at all during Phases 2–5.

**API types: hand-written to mirror the backend schemas.** `src/api/types.ts`
restates the shapes in `backend/app/schemas.py` by hand rather than generating a
client from the OpenAPI document.

## Consequences

**Good:**

- Tailwind keeps styling colocated with markup, so there is no separate
  stylesheet to keep in sync as components move around.
- Keeping ESLint means the ADR-002 decision holds and the ecosystem's dominant
  rule sets (including the React hooks rules) are available.
- The proxy decision means no CORS configuration, no preflight requests, and no
  environment-specific origin handling until there is a real deployment.
- Polling first keeps the frontend able to show progress with no backend
  changes at all, so the WebSocket work is a self-contained improvement rather
  than a prerequisite.

**Trade-offs / risks:**

- Tailwind's utility classes make markup verbose, and long `className` strings
  are harder to scan than a named CSS class. Accepted deliberately.
- Hand-written API types can silently drift from the backend: nothing fails if
  a Pydantic schema changes and TypeScript isn't updated to match. This is
  tolerable at the current size (two resources), but generating a client from
  the OpenAPI document is the obvious fix once it starts biting — and the
  API-first design in ADR-001 already guarantees a usable OpenAPI document.
- Polling wastes requests and adds up to a second of latency to each state
  change. Acceptable only because it is explicitly temporary.
- The Vite proxy exists only in development. A real deployment will need a
  different answer — serving the built static files from the backend, or a
  reverse proxy in front of both — which is a Phase 6 concern.

## Related

- ADR-001: Local-first, server-optional architecture
- ADR-002: Tech stack choices
- The original project plan: tech stack and roadmap
