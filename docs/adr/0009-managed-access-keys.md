# ADR-009: Managed access keys for import entrypoints

## Status

Accepted — 2026-07-24. **Amended 2026-08-19**, when the backend became an
optional self-hosted image — see *Amendment* below.

## Context

The Enhancement Track (C2) needs a way to gate the "advanced" features — the
ones that spend real resources by downloading audio — behind a secret the owner
hands out. The request was a "secret-key unlock". Two shapes were considered:

- **A single shared secret** (one env var). Simple, but un-revocable and
  un-trackable: if it leaks, the only fix is to rotate it and re-distribute to
  everyone.
- **A managed list of keys** — a small database table of individually
  revocable, labelled, usage-tracked keys.

The scope decision chose the managed
list, because it is the honest seed of the Phase-6 membership tier: the same
table grows into per-member entitlements. This is **not** an account system —
there is no login, no user rows, no passwords. It is a bag of capability tokens.

The guiding order also mattered: gating had to come **last**, after every import
entrypoint existed (add-a-link, search, Spotify import, YouTube import), so the
gate could be applied to all of them in one pass rather than retrofitted.

## Decision

Add an **`AccessKey`** table and a single dependency that gates the import
entrypoints.

- **Storage** — each key is a high-entropy random token (`secrets.token_urlsafe`)
  shown to the operator **once**, at creation. Only its **SHA-256 hash** is
  stored, so a database leak exposes no usable keys. Rows carry a `label` (who
  it's for), `created_at`, a nullable `revoked_at`, and a nullable
  `last_used_at`. SHA-256 (not bcrypt/argon2) is right here: the tokens are
  random and high-entropy, so there is no weak password to slow down guessing —
  a fast hash over an indexed column is what we want.
- **The gate** — a `require_unlock_key` FastAPI dependency reads an
  `X-Unlock-Key` header. It is **dormant until at least one active (non-revoked)
  key exists**: a fresh install, and the whole existing test suite, are never
  locked out. Once a key exists the gate enforces; revoking the last key opens it
  again (a deliberate recovery hatch for a single-owner app). A valid key updates
  `last_used_at`; a missing or bad one gets **401**. A hosted deployment that
  should stay locked even before any key exists sets **`REQUIRE_ACCESS_KEY=true`**,
  which forces the gate on.
- **The UI shows the lock, doesn't just hit the 401** — a `GET /access/status`
  endpoint reports `{locked, unlocked}` for the caller's key, so the web app
  renders an *"Importing is locked — paste your key"* notice in place of the
  import and search features when the gate is on and this device has no valid
  key. Entering a valid key there (or in Settings) unlocks it
  in place. The point is that a gated user *sees* the feature exists but can't use
  it until they ask the owner for a key — the intended distribution flow.
- **Where** — the gate covers the **playlist import** and **search** features:
  `GET /search`, `POST /playlist-imports`, `POST /playlist-imports/youtube`,
  `POST …/confirm`, and the retry endpoints. **Adding a single link (`POST
  /jobs`) is deliberately left open** — it's the lightweight, everyday path, and
  the owner wanted only the heavier import and search features behind a key.
  Browsing history, reading matches and reviewing aren't gated either — only the
  actions that kick off bulk work.
- **Management** — a small CLI (`scripts/access_keys.py`): `create` (prints the
  token once), `list` (label, created, last used, revoked), `revoke <id>`.
- **Client** — the web app stores a key in local storage (entered in Settings)
  and the API client attaches it as `X-Unlock-Key` on every request; only the
  gated endpoints care.

## Amendment — 2026-08-19: `POST /jobs` is gated after all

⚠️ **This reverses the one carve-out above.** The decision left "add a link"
open because playlist import and search were the expensive things and a single
link was the cheap, friendly path a keyless tester could still use.

Both halves of that reasoning expired when the server became optional:

- **It is no longer cheap *relative to the rest*.** The phone now fetches
  everything it can itself, so `POST /jobs` is the **only**
  endpoint that still spends the server's CPU and bandwidth — yt-dlp plus an
  ffmpeg transcode, per request, from anyone who can reach the host.
- **It is no longer one path among several.** A self-hosted MiO exists to serve
  this endpoint and almost nothing else. Leaving it open while telling
  self-hosters to "turn the access key on" — which that work originally proposed —
  would have gated the two things their phone never asks for and left the
  expensive one unguarded. The advice would have read as protection while
  protecting nothing.

**What does not change**: the gate is still dormant until the first key exists
(or `REQUIRE_ACCESS_KEY=true`), so a personal instance that has never minted one
is unaffected, and upgrading cannot lock anybody out of their own server.

## Consequences

- The feature is invisible until the owner runs the CLI to mint a key, at which
  point imports require one. This "opt-in by first key" keeps it out of the way
  for solo/local use while making it real the moment it's wanted.
- Keys are capability tokens, so the header travels on every request from a
  client that has one. That is fine over HTTPS; it is a secret to be treated like
  a password, not an identity.
- The hash-only storage means a lost key cannot be recovered, only revoked and
  re-issued — the correct trade-off for a secret.
- This lays the schema and the enforcement seam for Phase 6's membership tier
  without committing to accounts now.

## Related

- ADR-005 (Spotify import) — the "gate only what needs it" precedent
  (`require_spotify_settings`), which `require_unlock_key` mirrors.
- ADR-001 (async jobs) — the entrypoints being gated all enqueue background work.
- The scope decision, and the "gate last" ordering.
