# ADR-013: Importing playlists from NetEase, QQ Music and Kugou

## Status

Accepted — 2026-08-16

## Context

The NetEase, QQ Music and Kugou imports have cited this ADR since they were
filed in July 2026.
It was never written, and the three issues cannot be built without it: each one
defers its load-bearing rule — *"we must never touch their audio"* — to a
document that does not exist. A citation is not a decision.

Three premises in those issues have also drifted, all in the same direction:

| the issues say | what is true |
| --- | --- |
| "Depends on multi-source matching" | Bilibili as a fallback match source is **closed without having been built** — see decision 4 |
| "ADR-013 states this rule explicitly" | it did not exist until this file |
| `service="netease"`, `app/pacing.py`, "the standard matcher" | they describe a **server-side** import; searching and downloading onto the phone |

### What the sources actually give, measured

Everything below was measured on **2026-08-16** from a UK residential
connection, against **yt-dlp 2026.07.04** — the version in `backend/uv.lock`,
so this is the version that would ship. NetEase's and QQ Music's own numbers
still
reproduce — what does not survive is the design each drew from them.

| | one request gives | audio URL in the payload | measured |
| --- | --- | --- | --- |
| **NetEase** | `GET /api/v6/playlist/detail?id=…&n=1000` → all `trackIds`; `POST /api/v3/song/detail` with `c=[{"id":…}]` → title, `ar[]`, `dt` (ms), `al` | **none** | 95 tracks: 1.6 s + 2.2 s. 200 tracks: 2.2 s + 2.7 s |
| **QQ Music** | `GET i.y.qq.com/qzone-music/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=…` → `songname`, `singer[]`, `interval` (s), `albumname` | **none** | 20 tracks in 0.82 s; **a 3232-track playlist returned all 3232 in one response** |
| **Kugou** | `GET mobilecdn.kugou.com/api/v3/special/song?specialid=…&page=…&pagesize=…` → `filename` (`"artist - title"`), `duration` (s) | **none** (`topic_url` is `''`) | 37 tracks in 1.15 s; paginates, `pagesize=300` honoured, `total` reported |

None of the three needs credentials. Two findings change the issues materially:

**NetEase's paced per-track pass is unnecessary, and it is the only thing that
produces an audio URL.** `yt-dlp` on a `netease:song` URL costs **6.3 s per
track** (measured over six tracks) and every response carried a playable
`music.126.net` mp3 URL at 128–320 kbps. For a 95-track playlist that is ten
minutes spent to obtain, per track, exactly the thing the rule forbids
touching. The batch endpoint above returns the same title/artist/duration/album
for **200 tracks in 2.7 s** and contains no audio URL at all.

⚠️ **`song/detail` does contain one `music.126.net` URL, and it is a picture.**
`al.picUrl` is album artwork on the `p1`/`p2` hosts, ending `.jpg`; the audio
hosts are `m<digits>.music.126.net` and appear only in `song/url` and
`song/enhance`. Checked on the payload: zero matches for `.mp3`, `.m4a`,
`.flac` or an `m<digits>` host. Written down because a coarse grep for
`music.126.net` **does** hit, and would read as a broken rule to whoever runs
it next. The `h`/`m`/`l`/`sq` objects are bitrate and size metadata, not links.

**QQ Music's cookie requirement does not exist.** Per-*song* extraction does still
answer *"only available for registered users"* — confirmed, unchanged. But the
playlist endpoint already carries `singer`, `interval` and `albumname` for every
track, unauthenticated. yt-dlp fetches that payload and discards the fields in
flat mode; asking for the payload directly keeps them. So there is no
title-only mode, no `QQ_MUSIC_COOKIES` setting, and no "which mode did this run
in" notice to build.

**Kugou is confirmed as filed:** yt-dlp has no Kugou extractor, and Kugou's
`plat=0` endpoints answer unauthenticated. One refinement — artist and title
arrive glued together in `filename` and have to be split on `" - "`.

## Decision

### 1. We never ask for their audio, rather than declining to use it

The stated rule — audio comes from YouTube or Bilibili, never from these
platforms — is adopted, and it is implemented **structurally**: MiO calls the
metadata endpoints in the table above, which return no audio URL, instead of
calling an extractor that resolves one and then ignoring it.

This is a stronger guarantee than a coding rule, and it is cheaper: the whole
per-track pass that produces those URLs disappears, taking ten minutes per
playlist with it. A rule that no code path can break needs no discipline to
keep.

The consequence for `yt-dlp`: **it is not used for any of these three sources.**
That is not a stylistic preference — its NetEase extractor's job is to produce a
stream URL, so using it means requesting one.

### 2. The device fetches the track list; the server still scores it

The three issues describe the server calling NetEase. It should not, for
reasons that have each been paid for once:

- **It is where this project has been wrong before.** Measurement showed YouTube
  refusing the droplet at 1 request in 14, which moved searching and
  downloading onto the phone as a result. Adding three new server-side
  dependencies on third-party media APIs re-creates the shape that failed.
- **It is geo-proof by construction.** Whether a Frankfurt datacentre address
  can read NetEase is unmeasured (see *What is not measured* below). Under this
  decision it does not need to be: the connection that must reach a user's music
  service is the user's own. A phone in mainland China reaches all three; a
  droplet is a coin nobody has flipped.
- **These endpoints are undocumented and will change** — the Kugou issue says so
  itself.
  A fix in JavaScript ships over the air in about a minute; a fix in
  `backend/app/` needs a droplet deploy. For three APIs whose stability is
  nobody's promise, the repairable-in-a-minute side is the right home.
- It honours *"music lives on the user's device"*, which is the project's
  stated local-first architecture.

**What stays on the server is `matching.py`.** The matcher was split
deliberately: the phone searches, posts what it found to
`POST /playlist-imports/{id}/candidates`, and the server scores it, so that one
matcher cannot drift from itself. That split is unchanged here.

So the phone fetches the track list and posts it, and the server creates the
import and scores the candidates the phone later finds:

```
POST /playlist-imports/external
  { service, source_url, name,
    tracks: [{ external_id, title, artist, album, duration_s }] }
  → creates the PlaylistImport with client_matches=true, status=matching,
    one pending TrackMatch per track
POST /playlist-imports/{id}/candidates    (existing)
POST /playlist-imports/{id}/confirm       (existing, download=false)
```

The models already fit: `PlaylistImport.service` is a free string,
`external_playlist_id` holds the source URL, and `TrackMatch` already carries
title / artist / album / `duration_s` / `external_id`. This is one endpoint and
one schema — **no new background task, no new pipeline, no new backend
dependency**. The fetch phase is skipped because it has already happened.

### 3. These imports have a review step

Unlike ADR-010 (public YouTube) and ADR-014 (private YouTube), where each entry
*is* the video and there is nothing to guess, a NetEase track is a title and an
artist and the YouTube video for it has to be found. That is the situation
`TrackMatch.confidence` and the review screen were built for, and ADR-014's
*"it's from YouTube, user know what they importing"* does not transfer.

Worth stating because the shape of the Bilibili work makes the opposite tempting:
`listImport.ts` walks a list of **exact ids**. These sources hand back
**titles**. Pointing the generic loop at them would be skipping the matching
phase, not reusing it.

One structural note the review step absorbs: **a track with no artist can never
auto-match.** `score_candidates` weights title 0.55, artist 0.30, duration 0.15,
and `_similarity` returns `0.0` when either side is empty — so a missing artist
caps the score at **0.70**, or 0.75 with the Topic bonus, both under the 0.80
`AUTO_THRESHOLD`. That is correct behaviour, not a defect: a guess made with
less information should be looked at. It is also why Kugou's `" - "` split
failing on a title that itself contains `" - "` degrades to *more review* rather
than to wrong songs.

### 4. Candidates come from YouTube only, and `_TOPIC_BONUS` stays

`searchOnDevice` searches YouTube and nothing else, so every candidate any
import scores today is a YouTube result. The `+0.05` a `"… - Topic"` uploader
earns is therefore applied uniformly, and it is kept: Topic channels are
YouTube's auto-generated exact album audio, which is precisely what a
title-and-artist match wants to find.

It is recorded here because it is **structurally unfair the moment a second
candidate source exists** — no Bilibili uploader can earn it. **If a second
source is ever added to `searchOnDevice`, `_TOPIC_BONUS` must move behind a
per-source rule in the same change**; this ADR is the trigger.

⚠️ **And multi-source matching now has nothing tracking it.** It was
that work — search Bilibili when the best YouTube candidate scores under 0.80,
merge, rescore — and it was **closed as completed on 2026-08-13, "merged into
the Bilibili work"**, which delivered the Bilibili *import*: add-link, QR login,
folder
listing. It did not deliver fallback matching, and the code says so —
`searchOnDevice` searches YouTube and nothing else, and nothing in
`playlist_imports.py` consults a second source. The server-side halves that do
exist are H1's, in `ytdlp.py`: a `bilisearch` prefix, non-flat extraction, a
3-result cap.

So the position is: **multi-source matching is unbuilt and untracked.** These
three imports do not need it — they widen the *sources you can import from*,
not the pool each track is matched against. But that closure should not be
read as it having shipped, and if it is wanted, it needs a new issue. The
design agreed for it is still recorded §*"Picking Wave H
back up"*, along with the finding that killed it: from a non-China address the
binding constraint on Bilibili is **geo-restriction, not rate limiting**.

## Consequences

- **The three imports become the same feature three times**, differing only in
  a fetcher: a URL matcher, one or two HTTP calls, and a mapping to
  `{external_id, title, artist, album, duration_s}`. NetEase is built first as the
  pattern; QQ Music and Kugou should then be small.
- **No new backend dependency and no new Python.** `app/kugou.py`, proposed by
  Kugou, is not needed — the wrapper it describes lives in TypeScript on the
  phone. `app/pacing.py` is not needed either: one request per playlist has
  nothing to pace.
- **`--flat-playlist` is not the interface.** yt-dlp's flat mode drops the
  artist fields for NetEase and QQ *that the same response already contained*.
  Calling the endpoints directly is both faster and more complete.
- **The web client cannot do this**, because a browser would need CORS these
  APIs do not send. That is consistent with what already records the web
  client's imports as no longer working under a device-first architecture.
- **Each fetcher must check the count it was promised.** All three responses
  state how many tracks the playlist has (`trackCount`, `songnum`, `total`); a
  short list must fail loudly rather than import a truncated playlist quietly.
- **A guard test asserts no audio host is ever requested.** The rule in decision
  1 is only structural while the code stays that way, so the invariant is
  pinned: no fetcher may name `music.126.net`, `stream.qqmusic.qq.com` or a
  Kugou audio host, in the same shape as
  `__tests__/patchedModulesBuildFromSource.test.ts`.

### What is not measured

Stated plainly rather than left as a note, because *a known-unmeasured
assumption is not a note for later*:

- **Whether the droplet can reach these three APIs.** Not measured — an SSH
  session to it was not available while this was written. Decision 2 is chosen
  so the answer does not matter; if the server is ever given one of these
  fetchers, measure first.
- **Behaviour from a mainland-China connection.** Not measured. All three are
  Chinese services being read from their home market, so the expected direction
  is *better*, not worse — but that is a reasonable expectation, not a reading.

✅ **One of these has since been closed, from the phone** (2026-08-16, via
`adb shell curl`, so it is the device's own connection and not the laptop's):

```
GET  playlist/detail   200 in 2.5 s, 39736 B — byte-identical to the laptop
POST song/detail       200, name / ar[].name / dt: 253910 / al.name
```

The fields are exactly the ones `netease.ts` parses. ⚠️ **Same network, though**
— the phone is on the same UK residential connection, so this says the *device*
can do it, not that a different egress can.
- **What these endpoints do under sustained use from one address.** A handful of
  playlists each, in one session, from one address — no refusal was seen. The
  Bilibili work's
  Bilibili lesson was that a fresh address gets one or two clean responses before
  the refusals start, so this is not proof of a working steady state. Since a
  phone fetches one playlist per import the exposure is small, but the fetchers
  must surface a refusal **as a refusal**, never as an empty playlist.

## Related

- ADR-005 — Spotify playlist import: the matching-and-review pipeline these reuse
- ADR-010 — public YouTube import: the no-matching case, for contrast
- ADR-014 — private YouTube import: where "no review step" is correct, and why it does not transfer
- ADR-017 — releasing server audio once a device has it
- The three imports: NetEase, QQ Music and Kugou. Multi-source matching was closed 2026-08-13 without having been built (decision 4)
- The phone searches and the server scores; the device fetches its own audio
- YouTube refusing the droplet, 1 request in 14
