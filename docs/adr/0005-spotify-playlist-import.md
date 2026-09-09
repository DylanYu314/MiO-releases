# ADR-005: Spotify playlist import under the 2026 dev-mode constraints

## Status

Accepted — 2026-07-23

## Context

Phase 3 adds playlist import: connect a streaming
account, pull playlists and saved tracks, match each track to a downloadable
source, and queue the downloads through the existing import pipeline.
The plan assumed the Spotify Web API as it stood when it was written.

The ground has moved. Spotify changed its developer programme in November
2025 and again in February 2026:

- A **development-mode app only functions while the app owner holds an
  active Spotify Premium subscription**; if it lapses, the app stops working.
- At most **5 authenticated users** per app, added **manually** in the
  developer dashboard (there is no API for the allowlist), one app per
  developer.
- Dev-mode apps can only read the **authorizing user's own data** — their
  own/collaborative playlists and Liked Songs. Fetching arbitrary public
  playlists returns 403. Batch and browse endpoints were removed, and
  `GET /playlists/{id}/tracks` was renamed to `/playlists/{id}/items` (the
  per-entry field is now `item`, not `track`).
- The implicit grant flow, plain-HTTP redirect URIs and the `localhost`
  hostname were all removed; the only non-HTTPS redirect option is a
  loopback IP literal such as `http://127.0.0.1:8000/...`.
- The tier above dev mode ("extended quota") is restricted to registered
  businesses with 250k+ monthly users — permanently out of reach here.

(Sources: developer.spotify.com — the February 2026 migration guide, the
quota-modes and redirect-URI concept docs, and the November 2025 OAuth
migration notice.)

One more constraint is fundamental rather than new: the Web API serves
**metadata only** — there is no audio to download from Spotify. "Importing a
playlist" therefore means fetching its track list and finding each track on
YouTube, where the Phase-1 yt-dlp pipeline already knows how to download.

The decision, taken with eyes open: proceed anyway. Premium will be held
for roughly one month for live testing (owner plus up to four allowlisted
friends), then allowed to lapse — so graceful degradation is a hard
requirement, not a nice-to-have. Longer-term ideas that came out of the
same discussion (membership gating, other platforms) are recorded in
the deferred-ideas list, not here.

## Decision

**Auth: Authorization Code + PKCE, hand-rolled.** PKCE needs only
`secrets`, `hashlib` and an HTTP client, so no OAuth library is added and —
by design — no client secret exists to leak. The registered redirect URI is
the backend-direct loopback `http://127.0.0.1:8000/spotify/callback` (works
with or without the Vite dev server); the callback handler finishes the
exchange and 302s back to the frontend. `show_dialog=true` is always sent so
several accounts can connect from the same browser. Pending state/verifier
pairs live in an in-memory TTL dict — the same single-process justification
as the event broker in ADR-004; losing one just means clicking Connect
again. Tokens (access + refresh, read-only scopes) are stored as plain text
in the local database: acceptable on a single-user machine, to be revisited
before Phase 6 cloud mode.

**Two-module wrapper.** `app/spotify.py` is a pure HTTP wrapper with its
own exception types, mirroring `app/ytdlp.py` — that pattern is what keeps
the pipeline mockable in tests. It honours 429 `Retry-After` with capped
retries. Token persistence and silent refresh (a refresh response may or may
not rotate the refresh token; both are handled) live separately in
`app/spotify_accounts.py`, which is the only Spotify code that touches the DB.

**Two-phase import, Spotify only in phase one.** New models
`PlaylistImport` and `TrackMatch` (the planned data model) drive a
background job: fetch all track metadata — the only step that talks to
Spotify, seconds to a few minutes even for large playlists — then match each
track via yt-dlp `ytsearch` plus a rapidfuzz scorer (auto-accept ≥ 0.80,
review 0.55–0.80, otherwise no-match), ending in a `review` state. **Nothing
downloads until the user confirms.** Confirming starts phase two: one
`ImportJob` per accepted match, run sequentially through the unchanged
Phase-1 pipeline (sequential is deliberate — polite to YouTube, and
`BackgroundTasks` is effectively single-worker anyway), reusing an existing
song when one with the same `source_url` is already in the library, and
appending successes to a newly created local playlist. Because Spotify's
part ends with phase one, the 1-hour access-token expiry cannot kill a long
import, and nobody has to keep a session open while downloads run.

**Progress.** A second `JobEventBroker` instance streams `PlaylistImport`
state over a new WebSocket route. The broker is keyed by bare integer id,
so sharing the singleton with `ImportJob`s would collide; a second instance
keeps the id spaces apart without touching the broker code.

**Degradation.** With `SPOTIFY_CLIENT_ID` unset, Spotify endpoints return
503 "not configured" and the rest of the app is untouched. Once Premium
lapses (or an account drops off the allowlist), Spotify answers 401/403 —
surfaced as a clear "Spotify connection unavailable — the app owner's
Premium may have lapsed" error, and as a `failed` import with that message
when it happens mid-fetch. Import history stays browsable, and every
downloaded song, playlist and file keeps working: nothing in the library
references Spotify at runtime.

## Consequences

**Good:**

- The entire download path is reuse: matching feeds URLs into the same
  pipeline, WebSocket pattern and job conventions that Phases 1–2 built.
- Long imports are immune to token expiry by construction, not by clever
  token juggling.
- Review-before-download means a bad match costs a click, not a wrong file
  in the library — and no surprise bulk download of 200 wrong videos.
- The feature's end-of-life is designed: when the Premium month ends it
  fails loudly and harmlessly instead of rotting half-broken.

**Trade-offs / risks:**

- The feature only works while the owner pays for Premium, for at most 5
  manually-allowlisted accounts. Accepted: the point is the OAuth/matching
  engineering, and imports outlive the subscription.
- `ytsearch` is scraping, not an API — YouTube changes can degrade matching
  (per-track no-match, never a crash) until yt-dlp catches up.
- More single-process state (pending OAuth dict, second broker instance,
  in-process orchestration). Same caveat as ADR-004: all of it must move to
  real infrastructure when Celery arrives in Phase 4.
- A backend restart kills an in-flight import; a startup sweep marks
  non-terminal imports as failed rather than leaving them stuck. The real
  fix is Phase 4's persistent queue.
- Plaintext tokens in SQLite are fine locally and wrong for cloud mode —
  flagged for Phase 6.

## Update — after the first live import (2026-07-23)

The decision above was written before implementation. Recording what
building and running it actually showed, so the next reader gets reality
rather than intent:

**Two refinements to the decision as written.**

- *Confirming an import needs no Spotify configuration.* The plan implied
  the whole feature sat behind the "is Spotify configured" check. In the
  code only the endpoints that genuinely talk to Spotify do; once an import
  reaches `review`, everything left runs against YouTube, so a reviewed
  import can still be confirmed and downloaded after the owner's Premium
  lapses. Import history stays readable for the same reason.
- *Match review tracks where a URL came from.* Choosing one of the stored
  search candidates restores that candidate's score; pasting a custom URL
  clears the confidence instead of keeping a stale number, because there is
  no machine judgement behind a hand-typed link.

**What the first real run proved.** 130 tracks from a personal playlist:
fetched from Spotify in seconds, matched in a few minutes, 119 downloaded
successfully. The two-phase split held up exactly as intended — the Spotify
token was irrelevant long before the downloads finished — and no track ever
downloaded without being reviewed first.

**What it revealed.** All 11 failures were the same thing: YouTube answering
`HTTP 403: Forbidden` to the downloader partway through the batch. Not bad
matches, not missing videos — anti-bot throttling from downloading 130 files
back to back, and very likely transient. Two consequences worth acting on
later (both recorded as deferred): downloads in a long batch
should be *paced* the way Spotify requests already honour `Retry-After`, and
failed rows need to be viewable and retryable without re-importing the whole
playlist. The per-row failure isolation in the decision above is what kept
this to an annoyance instead of a lost import — the design absorbed the
failure mode it was built for, and the gap is in the recovery tooling, not
the pipeline.

## Related

- ADR-001: Local-first, server-optional architecture (async jobs)
- ADR-002: Tech stack choices (OAuth2 + PKCE was already the plan)
- ADR-004: In-process job event broker (the pattern reused for progress)
- The original project plan: the data-model sketch
- The deferred ideas from the same discussion
