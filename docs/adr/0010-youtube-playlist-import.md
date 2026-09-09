# ADR-010: YouTube public-playlist import

## Status

Accepted — 2026-07-24

## Context

Phase 3 built playlist import around Spotify: fetch a track list from an
external service, then *match* each track to a YouTube video (search + score),
let a human review the matches, and download the accepted ones. Spotify only
provides metadata — the audio always comes from YouTube.

The Enhancement Track (C1) adds importing a **public YouTube playlist** by URL.
Two things make this fundamentally cheaper than the Spotify path:

- **No API key.** yt-dlp reads a public playlist directly (private playlists and
  Liked would need Google OAuth — deferred).
- **No matching stage.** The playlist's entries *are* YouTube videos. There is
  nothing to search for or score — the "match" for each entry is the entry
  itself.

The question was how to add this without forking the import machinery. The
`PlaylistImport` model already carries a `service` discriminator and a
**nullable** `account_id`, and the whole confirm → download → retry chain keys
off `TrackMatch.chosen_url`, not off anything Spotify-specific.

## Decision

Add a **`service="youtube"` branch** to the import pipeline that reuses
everything downstream of matching:

- **Entry point** — `POST /playlist-imports/youtube {url}`, which needs no
  Spotify configuration. It creates a `PlaylistImport` with `service="youtube"`,
  `account_id=None`, `external_playlist_id=<url>`, and a placeholder name, then
  enqueues the same `playlist_import_task`.
- **Fetch, don't match** — `run_playlist_import` dispatches on `service`. The
  YouTube branch lists the playlist with yt-dlp (flat extraction, one request),
  sets the import's real name from the playlist title, and writes one
  `TrackMatch` per entry with `chosen_url` set to the video URL, its single
  candidate recorded, `confidence=None`, and status `auto_matched`. It then goes
  **straight to `review`**, skipping the `matching` stage entirely.
- **Reuse the rest unchanged** — because each entry lands as an importable,
  already-pointed match, the existing review UI, `POST /confirm`, the download
  pipeline (`run_confirmed_import` → `run_import_job`), per-track failure
  handling, adaptive pacing (B0), inline retries (B3) and the "retry failed"
  tooling all work with no changes. Nothing downloads until a human confirms,
  same as Spotify.
- **No schema migration** — every field needed already exists.

A URL that yt-dlp resolves to no playlist entries (e.g. a single video) fails
the import with a message pointing the user at the "Add link" page, which is the
right tool for one video.

## Consequences

- YouTube import works with zero configuration — it does not depend on
  `SPOTIFY_CLIENT_ID` and survives the owner's Premium lapsing, because it never
  touches Spotify at all.
- The `matching` stage and its confidence scores are simply absent for YouTube
  imports; the review table shows each video as a single auto-matched candidate.
  The user can still reject entries or repoint one to a different URL before
  confirming.
- `service` is now a real branch point, not just a label. A third source
  (Bilibili, private YouTube) becomes another fetch branch feeding the same
  review/download chain — the pattern is set.
- The playlist title (and therefore the import name) is only known after the
  background fetch, so the import briefly shows a placeholder name — mirrored to
  clients over the existing WebSocket as soon as it resolves.

## Related

- ADR-005 (Spotify playlist import) — the pipeline this extends.
- ADR-001 (async jobs), ADR-006 (Celery/Redis) — the background-job machinery reused.
- Deferred: private YouTube / Liked (Google OAuth) and other platforms.
