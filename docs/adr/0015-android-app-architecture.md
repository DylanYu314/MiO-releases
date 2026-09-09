# ADR-015 — Android app architecture (Expo, expo-router, expo-audio)

## Status

Accepted — 2026-07-25 (Phase 5, slice P1)

Amended — 2026-07-25 (Phase 5, slice P5): the decision stands, but one
consequence below was wrong. **Expo Go cannot test background audio or
lock-screen controls.** See "Correction: Expo Go's limit" at the end.

## Context

The plan calls for a React Native Android app that browses the library and
streams from the backend, with background audio and notification controls. Three
things had to be decided before any code: the **framework flavour** (Expo managed
vs bare React Native), the **navigation** library, and the **audio** library.

The plan named `react-native-track-player` for audio. That note was written long
before this phase started, and this repo has twice been bitten by trusting
planning-era notes about third-party tools — Spotify changed its developer
programme twice since the plan was written, and Bilibili's real search cost
turned out to be roughly 10× a recorded estimate. So the name was checked rather
than inherited.

**What the check found (2026-07-25):**

- **Expo SDK 57** is current (released 2026-06-30), moving the runtime to React
  Native 0.86 on React 19.2 — the same React major the web client already runs.
- **`expo-audio`** now covers everything this phase needs. It was not always so;
  historically `expo-av` lacked background/lock-screen support, which is exactly
  why `react-native-track-player` was the default recommendation.
  - background playback via `setAudioModeAsync({ shouldPlayInBackground })`
  - lock-screen and notification controls via `setActiveForLockScreen()` and
    `updateLockScreenMetadata()`
  - a queue, via the `AudioPlaylist` class, with gapless playback
  - **included in Expo Go**, so no custom development build to iterate
- **`react-native-track-player`** is still actively maintained and built on the
  New Architecture. It offers things `expo-audio` does not: Android Auto,
  caching and preloading.

## Decision

**Expo (managed) + TypeScript**, **expo-router** for navigation, and
**`expo-audio`** for playback.

`expo-audio` is chosen over `react-native-track-player` because it satisfies
every requirement of P5 (background audio, lock-screen and notification
controls) and P6 (queue) while keeping the app runnable in **Expo Go**. That
keeps the development loop fast and CI simple — no native build in the critical
path — and it is first-party, versioned in lockstep with the SDK, so it is one
fewer third-party dependency whose maintenance we have to track.

The features `react-native-track-player` adds are ones this phase does not need.
Android Auto is not a requirement. Caching and preloading matter for *offline
playback*, which the phase plan explicitly places outside this phase.

`expo-router` is chosen because it is Expo's own file-based router and the
default for new projects; adopting it in the skeleton avoids restructuring every
screen later, which is the expensive way to acquire a router.

**Revisit `react-native-track-player` if offline download lands** and
`expo-audio` + `expo-file-system` prove insufficient for it. That is the concrete
trigger, not a vague "if we outgrow it".

## Consequences

- The app runs in **Expo Go** during development: install one app on the phone,
  scan a QR code, iterate. ~~No EAS build is needed until P11 produces an APK.~~
  **Corrected in P5 — see below.** A development build is needed to test the one
  feature this phase exists for.
- **An Android trap to respect:** `setActiveForLockScreen` is not optional. On
  Android, background audio stops after roughly three minutes without it — an OS
  limitation, not a bug. Any playback work must set it, and P5 needs a test or a
  documented manual check that survives a real backgrounding.
- Sharing with the web client is limited to what is genuinely portable — the
  i18n catalogue and the tokens P2 extracts. Component code is rebuilt, as
  always planned (ADR-003 vs React Native primitives).
- **The Wave G audio engine does not come along.** `expo-audio` is a player, not
  a processing graph. Loudness normalization survives because the EBU R128
  measurement is taken at import and stored server-side (G4), so the client only
  applies a gain (P8). Crossfade, the ten-band EQ, mono downmix and balance are
  Web Audio-only (ADR-012) and would need a native module over Android's
  `AudioFx`. Recorded here so the gap is a known trade, not a later surprise.
- Choosing first-party Expo modules means the SDK upgrade cadence is ours to
  follow; an SDK bump can move `expo-audio` under us. The upside is that it moves
  *with* the runtime rather than lagging it, which is the usual failure mode of a
  third-party native audio module.

## Correction: Expo Go's limit (added in P5)

P1 recorded that `expo-audio` is "included in Expo Go", and inferred from that
that Expo Go could exercise background playback. The first half is true; the
inference is not.

On Android, lock-screen controls run as a **foreground service**
(`expo.modules.audio.service.AudioControlsService`). That service, and the
`FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_MEDIA_PLAYBACK` permissions it needs,
are added to `AndroidManifest.xml` by `expo-audio`'s **config plugin**. Expo Go
is a pre-built Play Store binary whose manifest was fixed when *it* was built,
so no config plugin of ours can add anything to it — and its manifest carries
none of those entries.

The module's JavaScript is present; the native manifest entries it depends on
are not. So `setActiveForLockScreen(true)` has nothing to bind to, and Android
applies its usual ~3-minute cutoff to background audio.

**This does not change the decision.** `expo-audio` is still the right library —
`react-native-track-player` would need a development build too, and rather more
of one. What changes is the development loop: a **development build** (`eas build
--profile development`) is needed once, from P5 onward, to test the feature the
app exists for. Everything else still iterates in Expo Go.

The wider lesson, which this repo keeps relearning: "the library is bundled" and
"the feature works" are different claims. The testing notes have the
practical instructions.

## Related

- The phase plan and its slice table
- ADR-003 — frontend architecture (the web client's equivalent decisions)
- ADR-012 — the Web Audio graph that does not port
- ADR-007 — theme tokens, which P2 must extract before they are shareable
