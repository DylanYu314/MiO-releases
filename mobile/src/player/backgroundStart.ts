/**
 * What a track start that nobody could hear actually did (#396).
 *
 * *"i can see the next track is started playing from lock screen, but no
 * audio. only when i open the app, audio regained"*. Reading `expo-audio`'s
 * source produced **three** candidates and could not separate them:
 *
 * 1. ~~`setActiveForLockScreen`'s foreground-service window swallows `play()`.~~
 *    **Eliminated 2026-08-11.** I reopened the app mid-track and found the
 *    position at ~4 seconds — exactly how long I took to open it. The deck was
 *    never refused; it started and kept running the whole time.
 * 2. Audio focus is not re-taken on a deck handover.
 * 3. The deck's gain is near zero from a fade that never ran — it *is* playing,
 *    silently.
 *
 * They want completely different fixes, and #303 cost this project five builds
 * by choosing between candidates from reading alone.
 *
 * ## Why the sentence is its own function
 *
 * `PlayerHost` cannot be asked "would you print something different if the code
 * were healthy?", and that is the question that matters. **#371 shipped a
 * diagnostic that could only ever print one value** — `running=false`, sampled
 * on the statement after an asynchronous `startForegroundService` — and it was
 * read as a finding for a day. The lesson from it is that an instrument which
 * cannot produce the other answer has measured nothing.
 *
 * So the wording lives here, where a test can hand it all three states and
 * check that all three come out different. Same split as `crossfade.ts` and
 * `marqueeRun`: the half worth getting right has no native object in it.
 */
export interface BackgroundStart {
  /** Which deck was told to play. Two exist because of crossfade (#201). */
  deck: 0 | 1
  /** `AppState.currentState` at the moment of the start. */
  state: string
  /** The crossfade multiplier applied to that deck — one half of candidate 3. */
  gain: number
  /**
   * The volume actually on the deck, read back rather than assumed.
   *
   * `gain` is what we *intended*; this is what the native object holds. They
   * can disagree — `applyLoudnessGain` multiplies four factors and any of them
   * can be the zero — and a diagnostic that reports only the intention cannot
   * tell "we asked for silence" from "something else silenced it".
   */
  volume: number | null
  /** The deck's clock when it was told to play, or null if it could not be read. */
  startedAt: number | null
  /** The same clock a couple of seconds later, or null. */
  now: number | null
  /** What the deck says about itself afterwards. */
  playing: boolean
}

/**
 * One line, and it has to be able to say three different things.
 *
 * | `playing` | `advanced` | means |
 * |---|---|---|
 * | false | — | the start was refused — candidate 2 |
 * | true | false | it thinks it is playing and the clock is frozen |
 * | true | true | it **is** playing; `gain` and `vol` say whether we silenced it |
 *
 * `advanced=unknown` is a fourth, deliberate outcome: a clock that could not be
 * read must say so rather than default to a number, which would read as a
 * measurement. The half-second threshold is slack for a renderer that started a
 * moment late, not a tolerance for a stalled one.
 *
 * Deck index, app state, gain and clock — nothing about *what* is playing.
 * #322 shipped song titles to the server in breach of an invariant stated in two
 * files, and a diagnostic is not a reason to do it again (#354).
 */
export function describeBackgroundStart({
  deck,
  state,
  gain,
  volume,
  startedAt,
  now,
  playing,
}: BackgroundStart): string {
  const advanced = startedAt !== null && now !== null ? String(now > startedAt + 0.5) : 'unknown'
  return (
    `deck=${deck} state=${state} playing=${playing} advanced=${advanced}` +
    ` gain=${gain.toFixed(2)} vol=${volume === null ? '?' : volume.toFixed(2)} at=${now ?? '?'}`
  )
}

/**
 * Whether a start in this app state is worth measuring at all.
 *
 * A **known** background state, never "anything that is not active". The guard
 * was the latter, and `AppState.currentState` is `undefined` under jest — the
 * runtime always has a value, the test environment does not — so every test
 * that played a track scheduled a probe. CI is 4–7x slower than a laptop, fired
 * them inside later tests, and failed a run in which all 1092 tests passed.
 *
 * The honest condition is also the correct one: this measures a start that
 * happened while the app was away, and an unknown state is not evidence that it
 * was.
 */
export function worthMeasuring(state: string | undefined): boolean {
  return state === 'background' || state === 'inactive'
}
