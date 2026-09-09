# ADR-012: A Web Audio processing graph

## Status

**Historical** — accepted 2026-07-25, and no longer part of the product.
amended by G2 — see "Update: the fade stage, G2" below. Amended again by
Phase 5's P8, which records how much of this graph reached Android: one
multiplier out of five stages.

⚠️ **Historical, but not wrong.** It was later settled that there is no web client and
there will not be one, so nothing here is part of the product any more. The code
it describes still exists and still works for a self-hoster; the reasoning for
the graph's shape is what makes this worth keeping.

## Context

`useAudioElement` binds **one** `<audio>` element straight to the DOM and sets
`volume`, `muted` and `playbackRate` on it. That is enough for playback and
nothing else. Three slices queued behind it need more:

- **G2 crossfade** needs two elements playing at once, with independent gain.
- **G3 EQ and mono/balance** need filter nodes in the signal path.
- **G4 loudness normalization** needs a per-track gain stage.

None of those are reachable from an element alone — `<audio>` exposes a single
volume scalar and no access to the signal. They all need the Web Audio API.

The risk is that this slice is **invisible by definition**: it re-plumbs the
audio path and must sound exactly the same afterwards. A refactor with no
observable output is the easiest kind to get subtly wrong, and the failure modes
are quiet — a context left suspended plays silence behind a moving progress bar.

## Decision

Route playback through a single `AudioContext`, built once, with an A/B element
pair feeding it.

```
elementA -> sourceA -> normGainA \
                                  -> fadeGain -> (EQ chain) -> (mono/balance) -> destination
elementB -> sourceB -> normGainB /
```

G1 builds this whole spine and leaves every stage at unity. The EQ and
mono/balance stages are named above but are **not** inserted until G3 — an
identity node is still a node, and a chain of them is a chain to get wrong.
`normGainA/B` and `fadeGain` exist at 1.0 because G2 and G4 need somewhere to
attach; deck B is created, wired and silent.

Four decisions inside that shape, each of which could have gone the other way:

**Volume and mute stay on the element.** Not on a `GainNode`. Measured: an
element routed through a `MediaElementAudioSourceNode` still honours both, and
applying volume on the element *and* a gain node multiplies them — 0.5 becomes
0.25, plainly audible. Keeping volume exactly where it is today makes the graph
provably transparent and leaves the smallest possible diff. G4's normalization
gets `normGain`; it does not get to share the user's volume control.

**The context is a page-lifetime singleton.** `createMediaElementSource` binds
an element permanently: calling it twice on one element throws, and so does
binding the same element to a *second* context. So a context that is closed can
never have its decks re-attached — the audio path would be dead for the rest of
the session with no way back. There is therefore no "recreate the context on
error" path, and no per-mount context.

**The single-element path stays as a fallback.** If `AudioContext` is missing or
its construction throws, playback runs exactly as it does today, straight off
deck A. This is not defensive padding: it is the escape hatch that lets the
graph be introduced without making playback itself newly fragile.

**The context is resumed from a user gesture.** Browsers start it `suspended`,
and a suspended context routed to the destination produces silence while the
element happily reports it is playing — the worst failure mode available here,
because everything *looks* right. Resume is tied to the play path rather than to
mount.

## What was measured, not assumed

Probed in real Chromium against a 440 Hz sine of amplitude 0.5 (theoretical RMS
0.35355), reading the graph's own `AnalyserNode`:

| Question | Result |
|---|---|
| Is a unity chain transparent? | RMS **0.35409** vs 0.35355 theoretical — 0.15%, analyser windowing |
| Does `element.volume` still apply through the graph? | Yes — ratio **0.500** at `volume = 0.5` |
| Does `element.muted` still apply? | Yes — RMS **0** |
| Volume on element *and* gain node? | ratio **0.250** — the squaring trap, confirmed |
| `createMediaElementSource` twice on one element? | `InvalidStateError` |
| Same element bound to a second context? | `InvalidStateError` |
| Do `playbackRate`/`preservesPitch` survive routing? | Yes |

The audio is same-origin (`/api/songs/{id}/audio`), so there is no CORS taint
and the analyser can read the signal — which is what makes G4's loudness
measurement possible later.

## Consequences

- **`useAudioElement`'s contract is unchanged.** It still returns
  `{ audioRef, currentTime, duration, seek }`, and `audioRef` is still deck A.
  The characterization suite added before this slice passes **unedited** — that
  is the evidence the refactor was inaudible, and any assertion that had needed
  changing would have been an admission of a behaviour change.
- Routing through a `MediaElementAudioSourceNode` resamples when the file's rate
  differs from the context's. "Bit-identical" would be an overclaim; transparent
  at unity gain is the honest one.
- `src/test/setup.ts` gains an `AudioContext` stub. Without it jsdom has no
  `AudioContext` at all, so every test would silently take the fallback path and
  the graph would ship with zero coverage behind a green suite.
- Both paths are tested against the same assertions, so "the graph is
  transparent" is a property the suite checks rather than a claim in a PR body.
- G2 attaches to `fadeGain` and the idle deck; G3 inserts its filters between
  `fadeGain` and the destination; G4 drives `normGainA/B` per track. None of them
  need to touch the element bindings again.

## Update: the fade stage, G2

G1 specified a **single** `fadeGain`, shared by both decks. That cannot express
a crossfade — blending two sources needs a gain each, moving in opposite
directions; one shared gain can only duck them together. The shape is now:

```
deckA -> sourceA -> normGainA -> fadeGainA \
                                            -> master -> destination
deckB -> sourceB -> normGainB -> fadeGainB /
```

`fadeGainA`/`fadeGainB` are the crossfade stage; `master` is the single point G3
will insert its filters before. Crossfade deliberately does **not** borrow
`normGainA`/`normGainB` — those are G4's, and two features automating one
AudioParam would fight.

Deck A starts at unity and deck B at zero, so with crossfade off the audible
path is unchanged from what G1 measured.

**The fade is equal-power, not linear.** Uncorrelated signals sum in power, not
amplitude, so two linear ramps crossing at 0.5 give a combined level of
√(0.5² + 0.5²) ≈ 0.707 — a 3 dB hole in the middle of every transition, heard as
a lull rather than a blend. `cos`/`sin` quarter-waves hold `out² + in² = 1`
throughout. Measured on two uncorrelated tones rendered offline:

| Crossfade shape | Deepest dip |
|---|---|
| Linear ramps | **−2.79 dB** (theory: −3.01) |
| Equal-power curves | **−0.03 dB** |

The curves are scheduled with `setValueCurveAtTime` and start from the
parameter's *current* value rather than a fixed 1 or 0, so interrupting a fade
in progress stays continuous. `cancelAndHoldAtTime` freezes the running
automation where it stands first; a plain `cancelScheduledValues` would snap
back to the value scheduled before the fade began, which clicks.

Three behavioural choices, made in G2:

- **Crossfade is off by default**, and applies to manual skips as well as
  natural track ends (the owner's call — one behaviour, one mental model). Off
  by default is what keeps G1's characterization suite valid: with crossfade at
  0 the path is byte-for-byte the old one.
- **The queue advances early.** A `timeupdate` watcher calls `next()` once the
  remaining time drops below the crossfade duration, so the store's current song
  is the *incoming* one for the length of the fade and the outgoing deck plays
  out underneath. The alternative — waiting for `ended` — leaves no time to
  overlap anything.
- **Repeat-one never crossfades.** Blending a track into itself is a flanger,
  not a transition; it restarts as before.

Because the outgoing deck keeps firing events while it fades, every element
listener ignores events from whichever deck is not active. Without that, the
outgoing `ended` advances the queue a second time and its `timeupdate` drags the
progress bar backwards.

## Update: the processing chain, G3

The stages ADR-012 named but deliberately left out are now in, between `master`
and the destination:

```
... -> master -> eq[0..9] -> channelMix -> panner -> destination
```

**Ten octave-spaced `BiquadFilterNode`s** at 31/62/125/250/500/1k/2k/4k/8k/16k.
Shelves at the two ends and peaking filters between, so a boost at 31 Hz lifts
everything below it rather than putting a bump around 31 and leaving 20 Hz
alone. Peaking Q is 1.41 — one octave of bandwidth, matching the band spacing.
Range is +/-12 dB.

**Mono is one node, not a splitter/merger lattice.** A `GainNode` with
`channelCount = 1`, `channelCountMode = 'explicit'` and
`channelInterpretation = 'speakers'` makes the spec's own downmix produce
(L+R)/2. Measured: channels come out identical and at exactly 0.5x the original
single-channel level. Switching back to `channelCount = 2` passes stereo through
untouched.

**Balance is a `StereoPannerNode`**, which is transparent at pan 0 for stereo
input by the spec's own formula (at pan 0 the cross-term coefficient is
cos(pi/2) = 0), and uses an equal-power law elsewhere.

The whole chain at neutral settings was measured **bit-transparent** — worst
sample difference exactly 0.0 against not having the chain at all, on a stereo
signal with different content per channel. Peaking and shelving filters at 0 dB
gain are mathematically unity, so there is no bypass logic and no reason for
any.

Settings live in their own store (`src/player/audioSettings.ts`, persisted)
rather than the player store: this is audio *processing* configuration the
listener tunes once, not *playback* state that changes per track.

Values are assigned rather than ramped, unlike the crossfade — these are
deliberate adjustments made while listening to the result, so they should land
immediately.

Still out of scope, and recorded here so it is not revisited: Dolby and spatial
audio need a licensed decoder and content carrying object metadata, and no web
API can open the operating system's own equalizer. Mono plus balance is the
honest version of the first request; this chain is the honest version of the
second.

## Update: loudness normalization, G4

`normGainA`/`normGainB` — reserved since G1 and left at unity ever since — now
carry a per-track correction, so the wave's last slice needed no new nodes at
all.

**Measured once at import, corrected at playback.** `app/loudness.py` runs
`ffmpeg -af ebur128=peak=true:framelog=quiet` and parses the integrated LUFS and
true peak into two nullable columns on `Song`. The audio files are never
rewritten: the measurement is metadata *about* the audio, not a change *to* it,
which means retargeting later is a settings change rather than a re-encode of
the whole library.

The playback gain is

```
gainDb = min(TARGET_LUFS - loudness, CLIP_CEILING_DBFS - truePeak)
```

with `TARGET_LUFS = -14` (where the streaming services have settled) and
`CLIP_CEILING_DBFS = -1`. The second term is what stops a quiet-but-peaky track
being lifted into clipping: a track at -24 LUFS "wants" +10 dB, but if it
already peaks at -3 dBFS it only gets +2. Real library files measure true peaks
*above* 0 dBFS — inter-sample peaks on lossy-encoded audio — which is exactly
why the ceiling is measured rather than assumed.

Three consequences worth naming:

- **An unanalysed track plays uncorrected.** Null means "no measurement", and
  guessing would be worse than leaving it alone. Every song predating this
  slice is null until `scripts/analyze_loudness.py` backfills it.
- **A failed analysis never fails an import.** Loudness is a nicety; losing it
  is not a reason to lose the track.
- **The gain follows the song, not the deck.** It is set wherever a song is
  placed — including onto the idle deck mid-crossfade, or the incoming track
  would arrive at the outgoing track's correction.

Normalization is **on** by default, unlike crossfade: it corrects an
inconsistency rather than adding an effect, and a library where every track
plays at its own level is the problem, not the baseline.

## Update: what reached Android, P8

Phase 5 ported this graph's one portable stage and nothing else. The gap is
recorded here rather than in the phase doc because the *reason* is a property of
this decision: the graph is a Web Audio graph, and Web Audio does not exist in
React Native.

| Stage | On Android |
|---|---|
| `normGain` — loudness normalization | ✅ Ported (P8) |
| `fadeGain` — equal-power crossfade | ❌ Needs two players driven by hand |
| `eq[0..9]` — ten-band EQ | ❌ Needs a native module over Android's `AudioFx` |
| `channelMix` — mono downmix | ❌ Same |
| `panner` — balance | ❌ Same |

Normalization crossed over because **the expensive half of it was never in this
graph.** The EBU R128 measurement happens once, server-side, at import (G4) and
is stored on the song row; `normGain` is only the multiplier that applies it. A
client needs no graph to multiply — `expo-audio` exposes a `volume` property, and
that is the entire Android implementation.

The formula moved to `shared/loudness.ts` so the two clients cannot drift. Two
targets differing by 2 dB would make the same library sound different on a phone
than in a browser, and nothing would look broken — the failure mode Wave D
existed to eliminate for the i18n catalogue.

**One number does differ, and it is a platform limit rather than a choice.**
`expo-audio` clamps volume to 0..1 in its Android source (`Playable.kt`:
`volume?.coerceIn(0f, 1f)`), so the app **cannot boost, only attenuate**. A
`GainNode` has no such limit, so the web client keeps the full correction and the
app passes `ATTENUATE_ONLY` to cap the result at unity. The cap is stated
explicitly rather than left implicit, so a quiet track is knowingly left quiet
instead of being "corrected" by a value the platform discards.

Measured against the 158-song reference library before choosing this: **82% of
tracks are louder than the -14 LUFS target** and so are attenuated exactly as on
the web. Only 18% lose anything, and they stay as loud as they already were
rather than getting worse. Attenuating the loud end is also where most of the
benefit is — it cut that library's spread from 19.4 dB to 9.7 dB.

Revisit if a native audio module is ever worth writing; that is the only route to
the other four stages, and to boosting.

## Related

- ADR-003 (frontend architecture) — the store stays pure; the graph is
  imperative and lives outside it, the same separation `useAudioElement` keeps.
- ADR-011 (two-tier queue) — supplies which song plays; this ADR is only about
  how its audio reaches the speakers.
- The audio work: this graph, then crossfade, the equaliser, and
  normalization.
