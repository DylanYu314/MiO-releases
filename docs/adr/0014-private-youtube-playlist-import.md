# ADR-014: Importing private YouTube playlists

## Status

Accepted — 2026-08-13

## Context

A public YouTube playlist can be read by anyone, and this feature's whole reason
to
exist is the ones that cannot: a user's own private playlists are invisible
without their permission. That permission is Google OAuth and the YouTube Data
API v3, which is a second connected account alongside Spotify's (ADR-005).

The number was reserved when the issue was filed in Wave H and is written now,
with the feature, because two of its decisions were only settled while building
it.

**What had changed since the issue was written.** An earlier decision moved every
download onto
the phone: a pasted link, a search result and a playlist import all fetch their
audio on the device, because YouTube refuses the droplet's address — measured at
1 import in 14. So the question "how does the server import a private
playlist" no longer had a sensible answer, and the feature had to be designed
around the device doing the fetching.

## Decision

**The server does the authenticated *listing*. The phone does everything else.**

```
GET    /google/status                  configured? connected? whose channel?
GET    /google/login                   → Google's consent screen
GET    /google/callback                exchange, store, hop back to web or app
GET    /google/playlists               the account's own playlists
GET    /google/playlists/{id}/items    video ids + titles, for the device
DELETE /google/account                 disconnect
```

### There is no review step

My reasoning, 2026-08-12: it is from YouTube, and the user knows what they are importing.

Review exists for Spotify because a Spotify track **is not** a YouTube video:
the server has to guess which video is the song, which is what `matching.py` and
`TrackMatch.confidence` are for, and a human confirms the guess. A private
YouTube playlist hands back exact video ids. A review screen would list right
answers and ask whether they were right.

This removes more than it looks like: the feature needs **no `PlaylistImport`
rows, no matching, no jobs, no confirmation step and no server-side download**.
`GET /playlists/{id}/items` returns ids and the phone downloads each one exactly
as a pasted link does.

Two consequences worth stating:

- It honours *"music lives on the user's device"* by construction. The server
  never holds the audio, so there is no `confirm-receipt` handover (ADR-017) and
  nothing to release.
- **That refusal does not apply here.** The measurement is about yt-dlp scraping
  from
  the droplet; the Data API is authenticated and answers a datacenter address
  perfectly well. The *downloads* happen on the phone, which is where they
  already work. (One story does not stretch over two sites — the same mistake
  same point made about Bilibili.)

### The 7-day expiry is a UI requirement, not a footnote

While the consent screen sits in Testing, Google expires the refresh token about
every **7 days** and the account must be reconnected. That is the ordinary case,
not an edge one, so it is surfaced in three places: standing text on the connect
row, a named message on the picker, and a *Connect again* button beside it.

**This forced a change to the error contract.** Two unrelated things answer
**401** on the listing endpoints — the access-key gate (ADR-009) and a dead
Google authorization — and they ask the user for opposite actions: *add your
key* versus *reconnect the account*. A client reading only the status has to
guess, and it would guess wrong every seven days, turning a scheduled expiry
into "your access key is wrong".

So the Google 401 names itself:

```json
{ "detail": { "code": "google_reauth", "message": "..." } }
```

and `ApiError` carries `code`. In the **body** rather than a response header,
because a custom header is invisible to a browser unless CORS exposes it — a
mechanism that works on the phone and fails silently on the web is the shape of
fault `patch-package` already cost this project.

The other two failures keep their own codes and their own messages: **429** for a
spent quota (the one failure that waiting fixes — it resets at midnight Pacific)
and **503** for a server with no Google credentials.

### The client reuses the device-add machinery rather than growing its own

`importGooglePlaylistOnDevice` is a loop over `importToDevice`, which already
does every per-track step and records into `useDeviceAdds` — so the screen
watches the same `DeviceAddList` the add-link and search pages use. What
the loop adds is what a *list* needs and a single link does not: playlist
ordering across concurrent downloads, per-video failure that does not stop the
run, and skipping what the device already holds so a resumed run counts
only its own work.

Schema **v7** gives a local playlist its own `google_playlist_id`, so
re-importing a living playlist fills in the one already here instead of building
a second copy — and its own column rather than either `server_*` one, for the
reason v6 exists: those hold integers our server issued and YouTube's ids are
strings.

### A connected account is global

Exactly as `SpotifyAccount` is: this server is single-user, so anyone holding a
valid access key can list the owner's private playlists. That is the existing
bargain rather than a new one, but it is worth stating plainly — "private" here
means private from the public, not private from other key holders. Multi-user
ownership arrives with auth in Phase 6.

## Consequences

- **The owner must keep a Google Cloud project.** The setup procedure
  is the runbook. Publishing the consent screen would end the weekly expiry and
  requires Google's verification, which is out of scope for a personal,
  non-commercial project.
- **Quota is shared and finite.** The Data API's default allowance is per
  project, so listing is deliberately unpaged and cheap (one unit per fifty
  playlists) and a 429 is reported as a wait rather than a fault.
- **Deleted and private videos are dropped from the listing**, because YouTube
  keeps the row with a placeholder title and importing those produces songs
  called "Deleted video".
- **The web client has none of this.** Only the callback knows how to return to
  it. The Android app is the focus — there is no web client — and adding the UI
  later is
  a client-side job — the endpoints are already shared.

## Related

- ADR-005 — the Spotify import this mirrors, and diverges from at review.
- ADR-009 — the access-key gate, and the other 401.
- ADR-017 — the handover this feature never needs, because no audio is on the
  server to release.
- ADR-019 — the run outliving the screen.
- The backend listing endpoint, the OAuth flow, and the client that consumes them.
