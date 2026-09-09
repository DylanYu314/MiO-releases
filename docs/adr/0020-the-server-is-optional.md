# ADR-020: The server is optional

## Status

Accepted — 2026-08-19

## Context

MiO is about to be launched. Two of the decisions that launch requires turned
out to be the same decision.

**The money.** The ground rules were amended on 2026-08-14 to allow a sale, and
clause 5 of that amendment forbids the access key becoming the product, because
the key gates `GET /search` and `POST /playlist-imports*` — ingestion. The
donation page was
filed as "donate to get the access key" and therefore conflicted with it.

On 2026-08-19 I resolved it in the other direction:

> "if i developed a app allow me to get these musics, and i have to pay around
> 12 dollar a month plus maintaining work, why dont i just pay the subscription
> of other app?"

and

> "i am planning to make the repository public later, so you are right, access
> key system will become useless"

Both are right. A paywall in an **AGPL-3.0** repository is unenforceable — a
recipient may lawfully delete the gate and redistribute — and a subscription
priced against Spotify's is a product nobody needs.

**The cost.** The droplet is ~$12/month plus maintenance, forever, and the
capacity question was
open because nobody knew what it could hold. I have said three times, most
recently here, that features should move to the device.

### What was measured before deciding

The server's remaining role turned out to be far smaller than either the docs or
this repo's own comments claimed. Readings on 2026-08-19, not recollections:

| claim | reading |
|---|---|
| device imports still talk to the server | **false** — `src/library/deviceImport.ts` contains zero `apiFetch` calls |
| Bilibili search goes to the server | **false** — `searchOnDevice` handles it via `searchSource.ts`; the `apiFetch` branch at `src/api/search.ts:129` is unreachable and its doc comment is stale |
| the phone reads its library from the server | **false** — `src/api/songs.ts` exports only `formatDuration` |
| Spotify OAuth needs a confidential client | **false** — `app/spotify.py:152` `exchange_code()` takes **no client secret**; the flow has been pure PKCE all along |
| the server downloads confirmed playlist tracks | **false** — `playlistImport.ts:792` extracts on the device |
| `matching.py` is entangled with the pipeline | **false** — 218 lines of pure functions, no I/O |

So exactly three things needed a server, and two of them were portable. The
third is `POST /jobs` → yt-dlp, which genuinely cannot run on a phone.

⚠️ **ADR-001 is titled "Local-first, server-optional architecture" and has been
since the first week.** Its body only ever meant that the **F4 cloud tier** was
optional, not the backend. The title has been describing an architecture MiO did
not have; this ADR is what makes it true in the strong sense.

## Decision

**The server is not part of the product.** MiO ships as an Android app that
needs no backend, and I operate no service.

1. **Playlist-import state and scoring move to the device.** `matching.py` is
   ported to TypeScript and the `PlaylistImport` / `TrackMatch` tables
   become device schema v10.
2. **Spotify OAuth moves to the device**, using the PKCE flow the backend
   already implements without a secret.
3. **The app defaults to no server.** `app.json`'s `extra.serverUrl`
   becomes empty; `apiFetch` already fails cleanly with `No server configured`.
4. **The backend becomes an optional self-hosted image.** It keeps
   `POST /jobs`, the access key, the whole import pipeline and the web client as
   its UI. Nothing is deleted.
5. **MiO is free.** Money comes from donations that grant **nothing** — no key,
   no tier, no entitlement — through third-party platforms, so no payment code
   and no personal information enter this repository.
6. **The ground rule about the access key is kept and not amended.** It survives
   because there
   is no paid tier for the key to conflict with. Cloud sync is deferred.

### Why the drift guard changes shape

Matching was split deliberately — the phone searches, the server scores —
*"because one matcher cannot drift from itself"*. Porting the scorer ends that
argument, so it is replaced by a mechanism rather than by trust: a corpus scored
by Python is committed to `shared/matching-golden.json`, and **both** suites
assert against it. `shared/` is in no workflow's `paths-ignore`, so both run when
it changes.

This is deliberate penance for an earlier failure, where two documents asserted
an invariant
that nothing enforced and a Bilibili search shipped whose every match failed
before a request was made. A documented invariant is not an invariant.

## Consequences

**Good.**

- The recurring cost goes to zero, and the capacity ceiling stops being a question
  about my budget. A user who only uses YouTube and Bilibili makes *no*
  requests at all.
- **The legal position improves materially.** MiO stores nothing, transmits
  nothing and operates no downloading service. The privacy policy the launch needs
  becomes short and true rather than carefully worded.
- **AGPL-3.0 becomes the right licence rather than a problem.** With no paywall
  there is nothing for a fork to strip, a public repo satisfies §13
  automatically, and §13 forces anyone who *does* host MiO to publish their
  changes. `mutagen`'s GPL-2.0-or-later stops constraining anything.
- The app works offline, on a phone whose owner never heard of `mio.dlany.uk`.

**Bad, and accepted.**

- ⚠️ **"Other sites" now requires the user to run a server.** yt-dlp cannot run
  on the phone, and no amount of architecture changes that. For most users this
  removes a feature.
- **Match parity is a real risk.** `fuzz.token_set_ratio` is not plain
  Levenshtein, and a subtly wrong port silently degrades every import rather
  than failing. The golden fixture exists because of this and must be written
  before the port.
- **Moving Spotify OAuth onto the device needs a native build.**
- The web client is now a self-hoster's tool, which is the honest version of
  what the parked web-client issue already recorded.

**Neutral.**

- The access key (ADR-009) is not removed. It stops being MiO's gate and becomes
  a self-hoster's, which needs no code change.
- Per-install ownership becomes vestigial on the device, which is what
  local-first always said it would be — *"an interim step, not the destination"*.

## Related

- ADR-001 — whose title this finally makes true
- ADR-009 — the access key, retained for self-hosters
- ADR-013, ADR-014 — the import paths this moves
- ADR-017 — releasing server audio, the previous step in the same direction
- Why the device fetches its own audio: local-first, the datacentre refusal, and
  on-device downloading
- The iteration that delivered this, and cloud sync, deferred
- The donation page, rewritten against this
