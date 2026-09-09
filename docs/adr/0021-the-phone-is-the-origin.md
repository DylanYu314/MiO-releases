# ADR-021: The phone is the library's origin, and the droplet never holds audio

## Status

**Amended** — accepted 2026-09-08 as the first slice of the cross-device work,
and
amended the same day. The title still holds; half the document does not, and the
amendment below says which half.

## ⛔ Amendment, 2026-09-08: there is no web client, so no audio is transferred

Hours after accepting this, I decided **not to build a web version at
all**. `mio.dlany.uk` becomes a documentation and download site — the download
page, the privacy policy, nothing else. His reasons were the load an audio relay
would put on a 1-vCPU droplet, and the size of `react-native-webrtc`.

**Cross-device therefore means phone → phone, and it moves metadata only.** The
receiving phone fetches its own audio exactly as it already does everywhere else.

⚠️ **What that retires in this document:**

| section | status |
|---|---|
| **1. The phone is the origin** | ✅ **stands, and is more true than before** |
| **2. metadata vs audio** | ✅ stands; the audio row is now moot because no audio moves |
| **3. transport** | ⛔ **moot.** No audio crosses anything, so there is nothing to choose a transport for. `react-native-webrtc` is not needed |
| **4. pairing lands first** | ⛔ **moot.** Pairing was load-bearing *only* because audio was; with none, there is no boundary to cross and `owned_by()` keeps its single meaning |
| **5. no pull when the phone is off** | ✅ stands, trivially — a copy is a one-time event |
| **the §0 section** | ⛔ **moot in full.** MiO transfers a list of source URLs, not recordings. The recorded hole — *pairing proves co-presence, not identity* — stops mattering, because what could be shared is a list of links |

⭐ **And the alternative this document rejected is the one that was taken.**
"Relay metadata only" was dismissed here because a browser cannot fetch audio,
so a replica would show a library it could never play. That reasoning was
correct **and it only applies to a browser.** A second *phone* can fetch audio
perfectly well, which is the case this document did not consider — it framed the
replica as a web client throughout.

**So the mistake was in the framing, not the measurement.** The CORS reading
still stands and is why there is no web client (the parked issue records the three
routes to
one, for whoever reopens it).

⚠️ **What replaces the relay is a file**, not a smaller relay: `expo-file-system`
is already installed and provides `File.pickFileAsync` and
`Directory.pickDirectoryAsync`, so export and import need **no new dependency and
no native build**, and the droplet is not involved at all — ADR-020 stays true.
Being a file, it is also the **backup** MiO has never had.

Everything below is the original text, kept because the reasoning about what a
relay would have cost is what led to not building one.

---


## Context

Me, 2026-09-07:

> "maybe only use droplet server as a middleman to transfer data, not store it…
> the transfer can be done not just between web and phone, maybe across multiple
> devices too."

The shape is right, and the reason it is right is a measurement rather than a
preference.

### ⛔ A browser cannot fetch its own audio

Probed against `googlevideo` on 2026-09-07:

```
Origin: https://mio.dlany.uk     -> 206  bytes=1024  ACAO=<ABSENT>
no Origin (control)              -> 206  bytes=1024  ACAO=<ABSENT>
preflight OPTIONS                -> HTTP 400         ACAO=<ABSENT>
```

No CORS headers on a successful range request, and preflight refused outright.
The control returns real bytes, so the absence is a reading and not a broken
probe.

**The local-first move that saved the Android app cannot be repeated in a
browser.** Local-first works on a phone because it may make arbitrary
cross-origin requests;
a browser may not.

And the droplet cannot fetch on the browser's behalf either — that is the
**1 request in 14**, the refusal the entire architecture exists to escape.

So there is exactly one device in this system that can obtain audio, and it is
the phone. Everything else is downstream of that fact.

### What already exists

- **ADR-017's lifecycle is the receiving half.** `POST /songs/{id}/confirm-receipt`
  deletes the server's copy, `audio_released_at` records it, and `/audio` then
  answers **410 Gone**. Store-then-release is already the pattern; the missing
  piece is an *upload*.
- `GET /songs/{id}/audio` already serves **Range/206**.
- `app/events.py` is a generic per-id pub/sub broker over Redis with two
  instances; a third is nearly a one-liner.
- `handOverPlaylist` (`mobile/src/library/handover.ts:139`) is called by nothing
  but its own tests.

## Decision

### 1. The phone is the origin; every other device is a replica

The phone holds the library. A replica holds a copy of what it has been given
and can originate nothing. This is not a sync topology with peers of equal
standing, and calling it one would invite a conflict-resolution design that the
facts do not require.

### 2. ⛔ Metadata and audio are different problems and get different answers

They are treated together only because they arrive together.

| | metadata | audio |
|---|---|---|
| size | a few hundred KB for 500 songs | 4–5 MB a track |
| may rest on the droplet | **yes**, briefly | ⛔ **never** |
| §0 exposure | none — titles are not recordings | this is the whole question |

**Metadata may pass through the backend and may be buffered there.** It is
small, it is not a recording, and §0 says nothing about it.

**Audio must never rest on the droplet** — not in a TTL'd temp directory, not
swept later. "Storeless" means the bytes are never written to disk at all. A
temp file with a sweeper is a store with a promise attached, and the shape
says the promise is what rots.

### 3. ⭐ Prefer a transport where MiO's server never holds the audio

This is the load-bearing decision, and it is made for the §0 argument rather
than for performance.

**Preferred:** the droplet **signals only** and the bytes go device to device
(WebRTC, or the local network when both devices are on it). MiO then provides
introductions, not copies.

**Fallback:** a streaming pass-through on the backend, bytes never touching
disk, if the preferred path proves impractical.

⚠️ **The fallback is genuinely worse, and not because of CPU.** It is worse
because it makes MiO's server the thing the audio passes through, which is the
distinction §0 turns on. Bandwidth and the single vCPU are secondary — and
⚠️ **both are still unmeasured under traffic**: `load1` **3.19** with **787 MiB**
free was sampled during the droplet's own *build*, which prices a build and says
nothing about concurrent streams.

⚠️ **The preferred path has a real cost**: `react-native-webrtc` is a large
**native** module, so it needs a build and an Expo-compatibility answer, and
`plugins/` is native too. That is a slice of its own, not a detail.

### 4. Pairing lands first, and nothing else lands before it

`X-Install-Id` is MiO's ownership boundary and a phone and a browser are two
different installs. `owned_by()` has exactly one meaning today and every
isolation test depends on it. Until there is a primitive that says *these two
installs are the same person's*, there is nothing to scope a relay to.

⚠️ **Fail closed**: an unpaired install must see exactly what it sees today,
which is nothing.

### 5. When the phone is off, replicas serve only what they already hold

There is no pull. A replica cannot ask the origin for something the origin is
not awake to give. This is stated here so it is designed for rather than
discovered.

## ⛔ The §0 argument, and where it does not hold

The ground rule: **"Don't build features that distribute downloaded audio to
other
users."** It is load-bearing and enforced in code. The cross-device work requires
this ADR to
show the difference is real, and refuses the feature if the argument does not
survive being written down.

**Written down, it survives — but not in the form it is usually stated, and the
honest version has a hole in it.**

**What is true.** A relay between one person's own devices is not distribution
to *other users*. Four properties keep it that way, and each is a mechanism
rather than an intention:

1. **No discovery.** Nothing lets one install find another. A transfer requires
   the origin's holder to act, on the device, deliberately.
2. **Storeless.** The droplet never becomes a repository, so it cannot become a
   source independent of the phone.
3. **Scoped to a pair**, not to a public endpoint — which is why pairing comes
   first and why the argument is *made of* pairing rather than asserted beside
   it.
4. **Revocable and visible.** A user can see what is paired and unpair it.

**⛔ The hole, stated plainly: pairing proves co-presence, not identity.** A
short-lived code shown on one screen and typed into another proves somebody held
both devices. It cannot prove they were the same person's devices. Two people in
a room can pair, and then one can stream the other's library.

No pairing design fixes this, and pretending otherwise would be the kind of
asserted-invariant this repo keeps paying for.

**So the question is not "can this be misused" — it can — but "is MiO a
distribution service".** It is not, and the reason is the shape of the misuse:
it requires physical co-presence, one device at a time, with no discovery, no
index, and nothing at rest. That is the same exposure a home NAS or a shared
laptop has. §0 forbids *building the feature that distributes*, and the feature
being built here distributes nothing on its own.

**Three constraints keep it that way, and they are part of this decision:**

- ⛔ **A cap on paired devices.** A number small enough that the mechanism cannot
  become a service. This is the single most load-bearing limit and it should be
  low.
- ⛔ **Pairing requires co-presence** — a short-lived code read off a screen,
  never a link that can be sent.
- ⛔ **No transfer to an install that is not paired**, and no way to enumerate
  installs.

⚠️ **If any of those three is later relaxed for convenience, this argument
stops being true**, and the relaxation is the moment to revisit §0 — not the
feature that follows it.

### The alternative that would settle §0 completely, and why it fails

**Relay metadata only, never audio.** §0 would then be untouched, with nothing
to argue about.

⛔ **It fails on the measurement at the top of this document.** A browser cannot
fetch audio, so a metadata-only replica shows a library it can never play. The
feature reduces to a read-only catalogue of music you cannot hear on the device
you are looking at.

**That is worth stating clearly, because it means the value of this whole
direction depends on relaying audio.** There is no version of cross-device MiO
that is both useful and free of the §0 question. Anyone who wants to stop here
should stop for that reason, not because a smaller version exists.

## Consequences

**Good.**

- The web client stops being blocked on an impossibility. It was parked partly
  because its imports cannot work; the origin/replica split is the shape in
  which it can work at all.
- Nothing about the phone's local-first architecture changes. Local-first stands,
  and
  the phone remains able to work with no server.
- The droplet's cost profile is unchanged in the preferred design — signalling
  is cheap. The web client is already **static files in Caddy, ~46 MiB and ~0
  CPU**, capped at `96M`.
- ADR-017's endpoints, `events.py` and `handOverPlaylist` are reused rather than
  rebuilt.

**Bad.**

- ⚠️ **`react-native-webrtc` is a large native dependency**, and the repo's own
  history says native additions are where builds break. It needs a
  build, an Expo-compatibility answer, and a fingerprint bump.
- ⛔ **`owned_by()` gains a second meaning.** It has exactly one today, and
  `backend/tests/test_library_isolation.py` asserts it. Every isolation test is
  in the blast radius, and this is where an ownership bug would be most costly.
- ⚠️ **A dependency on the droplet returns** for anyone using cross-device,
  after ADR-020 removed it. The app alone still needs no server; this
  feature does.
- The single vCPU is untested under streaming load, and the fallback transport
  is the one that would find out the hard way.

**Neutral.**

- MiO stays free and sells nothing. Cross-device grants no entitlement and is
  not a tier — cloud sync remains deferred, and this is not it arriving by
  another name.

## Related

- **Device pairing**, which this ADR makes a precondition
- The cross-device work this answers; cloud sync, deferred; the web client
- ADR-017 — store-then-release, the receiving half already built
- ADR-020 — the server became optional; this is the one feature that
  needs it back
- Why the phone fetches its own audio: local-first, the datacentre refusal, and
  on-device downloading
- `X-Install-Id`, the boundary a relay has to cross
- The project's ground rules — the rule this document is required to survive
