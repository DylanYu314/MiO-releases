# ADR-017: Releasing the server's audio once a device confirms it has the file

## Status

Accepted — 2026-08-06

## Context

The local-first argument is that the user's music lives on their device. This is
the end
of it: once a device holds the audio, the server's copy is a cache at best, and
server storage grows with every user and every track forever.

**The premise had moved since that was written, and it is worth recording what
is actually left.** Two paths still put audio on the server:

| path | who uses it | does a device end up with a copy? |
|---|---|---|
| `POST /jobs` | the Bilibili page on mobile, add-link on web | **yes on mobile** — `ImportProgressPanel` calls `handOverSong` when the job finishes, which downloads it to the device |
| a playlist import confirmed with `download: true` | the web client only — mobile sends `download: false` | no |

So the redundancy this ADR is about is narrower than the issue assumed: it is a
song the *server* fetched, that a *phone* has since pulled down. On mobile that
is chiefly Bilibili, because it is the one source the device cannot fetch for
itself. Everything else already skips the server entirely — the device fetches
its own audio.

`handOverPlaylist` in `mobile/src/library/handover.ts` is **called by nothing but
its own tests** — the confirmed-import path went to `importPlaylistOnDevice` when
mobile started sending `download: false`. Recorded here because it looks like a
third case and is not one.

## Decision

**The server deletes its audio when, and only when, a device explicitly confirms
it holds the file.**

- `POST /songs/{id}/confirm-receipt` is the trigger. The device calls it from
  `handOverSong`, *after* the bytes are on disk and recorded — not when the
  download starts, and not when the job reaches `done`.
- The **row stays**. Only the bytes go. `Song` is what the library is, and the
  history in `ImportJob` still points at it.
- `audio_released_at` records the moment. An explicit column rather than
  inferring the state from a missing file, because "released to a device that
  asked for it" and "the file is not where the row says it is" are different
  things and only one of them is a fault.
- `GET /songs/{id}/audio` answers **410 Gone** for a released song, not 404. The
  audio was here and was deliberately given up; reporting that as
  "missing from storage" would send whoever reads it looking for a bug.
- Confirming twice is a **204**, not a 409. A retry, a duplicate tap or an app
  restarted mid-request must not make a successful outcome look like a failure.

### Why the trigger cannot be "the job is done"

This is the constraint named first, and it is visible in the code. The
handover's failure path deliberately leaves the song unmarked so the next launch
tries again — **and that retry reads the server's copy** (`saveSongToDevice`
against `/songs/{id}/audio`). A job is `done` the moment the *server* has the
file, which is strictly before any device does. Deleting then would race the one
mechanism that recovers a failed handover, and the failure would look like a
corrupt library rather than a deletion.

Only the device knows the bytes landed. So only the device can say so.

## Consequences

**A released track cannot be re-downloaded from the server.** If the phone's
file is lost — the app is uninstalled, storage is cleared, the file is deleted —
the audio is gone. For a YouTube track that is recoverable by adding the link
again. **For a Bilibili track it is not recoverable on the device at all**,
because there is no on-device path; the user would have to add it again through
the server, which re-downloads it. That is a real cost and it is accepted: it is
the same cost the local-first library already carries everywhere else, since the
device database has no backup either.

**A second install has no route to the audio — and did not have one before
this.** A row is owned by an *install*, so a new install already sees
none of the old one's songs. Deleting the bytes removes a capability nobody
could reach. This is recorded rather than waved past because the plan asks for it to
be an accepted answer instead of an accident: **there is no cross-device sync in
MiO, and this ADR does not create the need for one — it makes the existing
absence permanent for released tracks.**

**The web client is unaffected.** It has no local library, never calls
`confirm-receipt`, and its songs are owned by its own install — so nothing it
holds is ever released.

**A `file_path` may now point at nothing, legitimately.** Anything walking the
library directory or reconciling rows against disk has to read
`audio_released_at` before calling a missing file a problem.

## Related

- Music lives on the device
- An install owns rows; a key only gates
- The device fetches its own audio, so most tracks never reach the server
- Bilibili is the one route where the server still downloads
- ADR-001 — storage abstraction; this deletes through the same path `DELETE /songs/{id}` uses
