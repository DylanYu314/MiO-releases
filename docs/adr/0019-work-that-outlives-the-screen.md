# ADR-019 — Work that outlives the screen going off

## Status

**Accepted** — 2026-08-07.

I settled both open questions: **instrument the queue
advance rather than fixing it blind**, and **build the import foreground service
in this iteration**. Neither is verifiable until the next native build.

## Context

Four bug reports from the v0.5.0 device pass were diagnosed as one cause: Android
suspends a backgrounded app's JavaScript, so the queue advance and the device
import loop — both JS — stop, while audio continues because ExoPlayer is native
(ADR-015).

That diagnosis is **right about the imports and incomplete about the queue**, and
the difference matters enough to change what gets built. What follows was read
out of `mobile/node_modules/expo-audio/android/…`, not recalled.

### What the platform actually does

**`expo-audio` already runs a foreground service.**
`service/AudioControlsService.kt` is a `MediaSessionService` that calls
`startForeground`. It is bound from `AudioPlayer.setActiveForLockScreen(true)`
and from nowhere else — which `PlayerHost` calls, because ADR-015 records that
without it Android stops background audio after ~3 minutes.

A process with a foreground service is exempt from Android's cached-app freezer.
So **while music is playing, the app is not frozen**, and "Android suspends the
JavaScript" cannot be the whole explanation for bug 4.

**`didJustFinish` reaches JS through a poll, not a callback.**
`BaseAudioPlayer.startUpdating()` is a Kotlin coroutine — `delay(updateInterval)`
in a loop — that emits a status object; `useAudioPlayerStatus` turns it into
React state, and `PlayerHost:962` advances the queue in an effect on it. That is
four hops, three of which are throttleable, and none of which is the ExoPlayer
completion callback itself.

**`AudioPlaylist` cannot hold the lock screen.**
It is a real second `ExoPlayer` with `addMediaItem` / `seekToNextMediaItem`, so
its advance genuinely is native. But `AudioPlaylist.kt` contains **no
`MediaSession`, no service connection, and no `setActiveForLockScreen`** — those
exist only on `AudioPlayer`. This is the same limit `PlayerHost:37` recorded in
P6, re-checked against expo-audio 57.0.3 rather than inherited.

### What the imports need is not what the queue needs

The import loop has no foreground service of any kind. Nothing about it is
native. When the app is minimised and no music is playing, the process is an
ordinary cached app and it is frozen. **Bug 5 is exactly what the report says it
is.**

## Decision

### 1. Measure before fixing the queue

The diagnostics log already exists (S6, `mobile/src/diagnostics/log.ts`) and is
uploaded daily. Instrument the advance path before changing it: log the wall
clock at `didJustFinish`, at the effect that acts on it, and at the next
`AppState` change to `active`.

That distinguishes the three candidates that reading cannot:

| what the log shows | cause |
|---|---|
| `didJustFinish` never logged until resume | the native poll is throttled, or events queue |
| logged on time, effect runs on resume | React is not rendering in the background |
| both on time | the advance works and something else is the bug |

**This is the repo's own lesson applied**: a symptom that fits the hypothesis is
not evidence for it, and the diagnostic goes in *before* the fix. Three of the
four reports in this cluster were already misread once — what looked like an
auto-retry was a resume.

It is also **cheap and unblocking**: it ships with the next build regardless of
which fix follows, and the production build is where it gets read.

### 2. A foreground service for imports — `dataSync`, JS stays JS

For bug 5, hold a foreground service for the duration of a device import. A
foreground service takes the process out of the cached-app freezer, so **the
existing JavaScript download loop keeps running unchanged** — nothing in
`playlistImport.ts` moves to Kotlin.

- Type `dataSync`, not `mediaPlayback`: on Android 14+ the media type requires
  actively playing media, and an import is not that.
- Started when `importPlaylistOnDevice` begins and stopped in its `finally`, so
  the notification's lifetime is the run's.
- Expo has no first-party API for this, so it is a small native module beside
  `mobile/modules/mio-equalizer` — which is the precedent for what one costs
  here, and why the native-rebuild runbook exists.

**Cost, stated plainly:** a persistent notification while an import runs, a
`FOREGROUND_SERVICE_DATA_SYNC` permission, Android 14's 6-hour daily budget for
the type, and a native rebuild. Battery is the honest trade — the work was
always going to cost that; today it is spread over however many times the user
reopens the app, which is worse for the battery and much worse for them.

### 3. Rejected: hand the queue to `AudioPlaylist`

The report offers this as the cheap fix for bug 4. It is not cheap:

- **It gives up background audio to fix background advance.** No lock screen
  means no media session means the ~3-minute kill ADR-015 exists to avoid.
- **It deletes crossfade.** Crossfade is two `AudioPlayer` decks and a JS equal-power
  ramp; one `ExoPlayer` with a media-item list cannot overlap two tracks.
- **It takes the equaliser and loudness with it.** `PlayerHost` applies the EQ
  curve and the per-track loudness correction *per deck* — both are keyed to a
  deck holding one known song.

Three shipped features for one bug, and the bug is not yet measured.

### 4. Deferred, with a named trigger: `react-native-track-player`

If step 1 shows the advance genuinely cannot work in JS, the honest answer is
the library ADR-015 chose against — it is a native queue with its own foreground
service and lock-screen controls, which is precisely this problem. ADR-015
already names a revisit trigger (offline download); this is a second one.

It is not this iteration's work. It would rebuild `PlayerHost`, and it has the
same crossfade and equaliser questions as option 3, only answerable rather than
fatal.

## Consequences

- **The work splits.** The import service (bug 5) is buildable now. The queue
  advance (bug 4) becomes measure-then-decide, and may not need code at all.
- **A second native module**, so the native-rebuild runbook gains an entry and
  the queue work's
  fix cannot be verified until I build.
- **`playlistImport.ts` does not change again.** The previous wave just made the loop
  resilient and resumable; the service makes it not need to resume. The
  resumability stays regardless — a foreground service can still be killed.
- **The premise behind the report is amended, not discarded.** Four
  reports still share a cause for imports. For the queue, "JS is suspended" is
  a hypothesis with a foreground service arguing against it.

## Related

- ADR-015 — Android app architecture; the ~3-minute background-audio trap, and
  why `expo-audio` was chosen over `react-native-track-player`
- The bug report this ADR narrows: the app stops working when you look away
- The import loop's resilience and honest progress, already landed
- Lessons already paid for: "never call a cause confirmed from reading alone";
  "put the
  diagnostic in before the fix"
