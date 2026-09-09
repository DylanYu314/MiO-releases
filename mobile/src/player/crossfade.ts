/**
 * The arithmetic behind crossfade (#201), with no player in it.
 *
 * Kept apart from `PlayerHost` because this half is the part that can be
 * *checked*: the curve has an invariant, the trigger has edge cases, and
 * neither needs a native module or a fake audio player to test. What is left in
 * the host is wiring.
 *
 * The web client does this inside a Web Audio graph (Wave G, ADR-012), where
 * `setValueCurveAtTime` schedules the curve on the audio thread. There is no
 * `AudioParam` here, so the ramp is driven from JS on a timer — coarser, and it
 * can stutter under load. That is the honest difference; the curve itself is
 * the same.
 */

/** Steps per second while a crossfade runs. 20 Hz is fine enough that a level
 *  change is heard as a slide rather than a staircase, and cheap enough to run
 *  while the screen is off. */
export const CROSSFADE_STEP_MS = 50

export interface CrossfadeGains {
  /** Multiplier for the track going out, 1 → 0. */
  outgoing: number
  /** Multiplier for the track coming in, 0 → 1. */
  incoming: number
}

/**
 * The two gains at a point through the fade, `progress` running 0 → 1.
 *
 * **Equal power, not linear**, and the difference is audible rather than
 * academic. Two uncorrelated tracks sum in *power*, not amplitude, so a linear
 * pair (`1-p` and `p`) sums to 0.5 amplitude at the midpoint — about 3 dB down.
 * The listener hears a dip in the middle of every transition, which is exactly
 * what someone turning crossfade on is trying to avoid.
 *
 * `cos`/`sin` of a quarter turn keeps `outgoing² + incoming² === 1` throughout,
 * so the perceived loudness holds steady. That identity is the invariant worth
 * testing, and it is the one a "simplification" to a linear ramp would break.
 */
export function equalPowerGains(progress: number): CrossfadeGains {
  const p = Math.min(Math.max(progress, 0), 1)
  const quarterTurn = (p * Math.PI) / 2
  return { outgoing: Math.cos(quarterTurn), incoming: Math.sin(quarterTurn) }
}

/**
 * How long a fade can actually last on a track of `duration` seconds.
 *
 * Capped at **half** the shorter track, which is not fussiness: a 12-second
 * crossfade into a 10-second interlude would still be fading in as the track
 * ended, so the next transition would begin before this one finished and the
 * decks would fight over which is outgoing. Halving also keeps at least half of
 * every track playing at full level.
 *
 * `duration` is null while a track is still loading — nothing is known yet, so
 * nothing fades.
 */
export function effectiveCrossfadeSeconds(
  requestedSeconds: number,
  duration: number | null,
  nextDuration: number | null,
): number {
  if (requestedSeconds <= 0) return 0
  if (duration === null || duration <= 0) return 0
  const shortest =
    nextDuration !== null && nextDuration > 0 ? Math.min(duration, nextDuration) : duration
  return Math.min(requestedSeconds, shortest / 2)
}

/**
 * Whether the app is somewhere its JS timers will actually run.
 *
 * A **known** foreground state, by way of excluding the two known background
 * ones — the same shape as `worthMeasuring`, and for the same reason. That
 * function's comment records the cost of getting it backwards:
 * `AppState.currentState` is `undefined` under jest, so `=== 'active'` would be
 * false in every test and a suite that never crossfades would prove nothing
 * about a feature it thinks it covers.
 *
 * The runtime always has a real value. An unknown one is the test environment,
 * and treating it as "not backgrounded" is the honest reading.
 */
export function appIsActive(state: string | undefined): boolean {
  return state !== 'background' && state !== 'inactive'
}

/** One trip into the background: when it started, and how many status updates
 *  arrived during it. `since === 0` means the app never left. */
export interface HeartbeatWindow {
  since: number
  count: number
}

/** A heartbeat under this is a glance at the task switcher rather than a trip
 *  away, and one tick either way there proves nothing while filling the log. */
export const HEARTBEAT_MIN_WINDOW_MS = 1000

/** What a live `playbackStatusUpdate` loop emits, from `expo-audio`'s own
 *  default (`useAudioPlayer`'s `updateInterval = 500`). */
export const HEARTBEAT_INTERVAL_MS = 500

/**
 * What to say about a trip into the background that has just ended (#470).
 *
 * ## Why this decides whether #470 is JavaScript or Kotlin
 *
 * The ramp is a `setInterval`, and Android stops firing JS timers on host pause.
 * But `expo-audio` emits `playbackStatusUpdate` from a **Kotlin coroutine on
 * `Dispatchers.Main` driven by `delay()`** (`BaseAudioPlayer.kt:52-68`) — a
 * native timer, which nothing in `JavaTimerManager` can reach. If that keeps
 * arriving while the activity is paused, the ramp can be driven by it and #470
 * needs no native module at all.
 *
 * ⚠️ **The background advance is not evidence for this.** `didJustFinish` comes
 * from `onPlaybackStateChanged`, a player *listener*, so a queue advancing while
 * minimised proves event **delivery** and says nothing about the **periodic**
 * loop. Two mechanisms; only one of them is the one a ramp needs.
 *
 * ## Why `expected` is in the line
 *
 * So the line answers the question without the reader doing arithmetic on a
 * device report — `45/136` cost an hour once (#457) for exactly that reason.
 * `ticks` near `expected` is a living heartbeat; `ticks=0` over a real window
 * sends #470 to the native ticker.
 *
 * Returns null when there is nothing worth saying, so the caller has no rule of
 * its own to get wrong.
 */
export function heartbeatReport(
  window: HeartbeatWindow,
  now: number,
  isPlaying: boolean,
): string | null {
  if (window.since === 0) return null
  const awayMs = now - window.since
  if (awayMs < HEARTBEAT_MIN_WINDOW_MS) return null
  const expected = Math.floor(awayMs / HEARTBEAT_INTERVAL_MS)
  return `ticks=${window.count} over=${awayMs}ms expected=${expected} playing=${isPlaying}`
}

export interface CrossfadeTrigger {
  currentTime: number
  duration: number | null
  nextDuration: number | null
  requestedSeconds: number
  /** False when there is nothing to fade into — the end of the queue, or a
   *  repeat mode that has not decided yet. */
  hasNext: boolean
  /** True once a fade is under way, so the trigger cannot fire twice. */
  transitioning: boolean
  isPlaying: boolean
}

/**
 * Whether now is the moment to start fading into the next track.
 *
 * Every guard here is a real case rather than defensive padding:
 *
 * - **`requestedSeconds <= 0`** is the default, and it must take the same path
 *   the app took before this feature existed. Crossfade off means one deck.
 * - **`!hasNext`** — the last track of a queue fades into silence otherwise,
 *   which is a bug that sounds like a feature until the track just stops early.
 * - **`transitioning`** — status ticks arrive about twice a second and the
 *   condition stays true for the whole tail, so without a latch this would
 *   start a new fade on every tick.
 * - **`!isPlaying`** — a paused track sitting inside the tail must not start
 *   the next one on its own.
 * - **`currentTime <= 0`** guards a freshly loaded track reporting a duration
 *   before a position, where `remaining` would look like the whole track.
 *
 * ## Why this no longer refuses to fade in the background (#455 → #470)
 *
 * It used to, and the reasoning was sound at the time. **React Native stops
 * firing JS timers while the Android activity is paused** — `JavaTimerManager`
 * `onHostPause()` removes the `TIMERS_EVENTS` frame callback, and
 * `TimerFrameCallback.doFrame` returns early while paused *without re-posting
 * itself*, so the pump stops rather than skipping a beat. The ramp was a
 * `setInterval` and the incoming deck starts at **gain 0**, so a fade begun
 * while backgrounded played the next track at volume zero until the app came
 * forward. I reported exactly that, three device passes running.
 *
 * What changed is that the ramp gained a **second driver that survives the
 * pause**: `expo-audio` emits `playbackStatusUpdate` from a Kotlin coroutine on
 * `Dispatchers.Main` (`BaseAudioPlayer.kt:52-68`), which `JavaTimerManager`
 * cannot reach. Measured on the device before relying on it, over 135 s
 * backgrounded with audio playing:
 *
 *     queue.heartbeat ticks=272 over=134582ms expected=269 playing=true
 *
 * ⚠️ **The background *advance* was never evidence for this**, and reading it
 * that way is the trap that cost this iteration several days: `didJustFinish`
 * comes from `onPlaybackStateChanged`, a player *listener*, so a queue advancing
 * while minimised proves event delivery and says nothing about the periodic
 * loop. Delivery and periodicity are different mechanisms.
 *
 * At ~2 Hz a backgrounded fade gets roughly a twentieth of the foreground's
 * resolution — about 24 steps across 12 seconds rather than 240. That is a
 * coarser ramp, not a different one: `step` recomputes from the wall clock, so
 * the curve and the duration are unchanged.
 */
export function shouldStartCrossfade({
  currentTime,
  duration,
  nextDuration,
  requestedSeconds,
  hasNext,
  transitioning,
  isPlaying,
}: CrossfadeTrigger): boolean {
  if (!isPlaying || transitioning || !hasNext) return false
  const seconds = effectiveCrossfadeSeconds(requestedSeconds, duration, nextDuration)
  if (seconds <= 0) return false
  if (currentTime <= 0 || duration === null) return false
  return duration - currentTime <= seconds
}
