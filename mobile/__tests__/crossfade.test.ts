import {
  appIsActive,
  effectiveCrossfadeSeconds,
  equalPowerGains,
  heartbeatReport,
  shouldStartCrossfade,
  type CrossfadeTrigger,
} from '../src/player/crossfade'

/**
 * The arithmetic behind crossfade (#201).
 *
 * Worth its own file precisely because it needs no player: the curve has an
 * invariant and the trigger has edge cases, and both can be checked exactly
 * rather than inferred from a fake audio object.
 */

describe('the equal-power curve', () => {
  it('holds constant power across the whole fade', () => {
    // The invariant, and the reason this is not `1 - p` and `p`: two
    // uncorrelated tracks sum in power, so a linear pair is ~3 dB down at the
    // midpoint and the listener hears a dip in every transition.
    for (let step = 0; step <= 20; step++) {
      const { outgoing, incoming } = equalPowerGains(step / 20)
      expect(outgoing ** 2 + incoming ** 2).toBeCloseTo(1, 10)
    }
  })

  it('is a real crossfade at the midpoint, not a switch', () => {
    const { outgoing, incoming } = equalPowerGains(0.5)
    // Both audible, and equal — 0.707 each, which is the point of the curve.
    expect(outgoing).toBeCloseTo(Math.SQRT1_2, 6)
    expect(incoming).toBeCloseTo(Math.SQRT1_2, 6)
    // A linear ramp would give 0.5 here, so this also pins the difference.
    expect(outgoing).toBeGreaterThan(0.5)
  })

  it('starts on the outgoing track and ends on the incoming one', () => {
    expect(equalPowerGains(0)).toEqual({ outgoing: 1, incoming: 0 })
    const end = equalPowerGains(1)
    expect(end.outgoing).toBeCloseTo(0, 10)
    expect(end.incoming).toBeCloseTo(1, 10)
  })

  it('clamps rather than running past either end', () => {
    // A timer that fires late gives progress > 1; a negative one should never
    // happen, and neither should invert the fade if it does.
    expect(equalPowerGains(1.4).incoming).toBeCloseTo(1, 10)
    expect(equalPowerGains(-0.3).outgoing).toBeCloseTo(1, 10)
  })
})

describe('how long a fade may last', () => {
  it('is what was asked for when both tracks are long enough', () => {
    expect(effectiveCrossfadeSeconds(8, 200, 200)).toBe(8)
  })

  it('never exceeds half the shorter track', () => {
    // A 12-second fade into a 10-second interlude would still be fading in as
    // the track ended, so the next transition would begin before this one
    // finished and the decks would fight over which is outgoing.
    expect(effectiveCrossfadeSeconds(12, 200, 10)).toBe(5)
    expect(effectiveCrossfadeSeconds(12, 10, 200)).toBe(5)
  })

  it('is nothing at all when crossfade is off', () => {
    expect(effectiveCrossfadeSeconds(0, 200, 200)).toBe(0)
  })

  it('is nothing while a duration is unknown', () => {
    // Null means still loading. Fading against a guess would cut a track short.
    expect(effectiveCrossfadeSeconds(8, null, 200)).toBe(0)
    // The *next* duration being unknown is survivable — the current track's
    // half still bounds it.
    expect(effectiveCrossfadeSeconds(8, 200, null)).toBe(8)
  })
})

describe('when a fade starts', () => {
  function trigger(overrides: Partial<CrossfadeTrigger> = {}): CrossfadeTrigger {
    return {
      currentTime: 175,
      duration: 180,
      nextDuration: 180,
      requestedSeconds: 8,
      hasNext: true,
      transitioning: false,
      isPlaying: true,
      ...overrides,
    }
  }

  it('starts once the tail is reached', () => {
    expect(shouldStartCrossfade(trigger({ currentTime: 172 }))).toBe(true)
  })

  it('does not start before it', () => {
    expect(shouldStartCrossfade(trigger({ currentTime: 171 }))).toBe(false)
  })

  it('never starts when crossfade is off, which is the default', () => {
    // The safety property of the whole feature: at 0 the app must take exactly
    // the single-deck path it took before #201 existed.
    expect(shouldStartCrossfade(trigger({ requestedSeconds: 0 }))).toBe(false)
  })

  it('does not fade the last track into silence', () => {
    expect(shouldStartCrossfade(trigger({ hasNext: false }))).toBe(false)
  })

  it('does not start a second fade while one is running', () => {
    // Status ticks arrive about twice a second and the condition stays true for
    // the whole tail, so without this it would restart on every tick.
    expect(shouldStartCrossfade(trigger({ transitioning: true }))).toBe(false)
  })

  it('does not start the next track while paused', () => {
    expect(shouldStartCrossfade(trigger({ isPlaying: false }))).toBe(false)
  })

  it('ignores a track that has reported a duration but no position yet', () => {
    // A freshly loaded track reads currentTime 0, where `remaining` is the
    // whole track and would look like the tail on anything short.
    expect(shouldStartCrossfade(trigger({ currentTime: 0, duration: 6 }))).toBe(false)
  })

  it('uses the capped length, not the requested one', () => {
    // 12 requested but the next track is 10s long, so the fade is 5s and starts
    // at 175 — not at 168 as the raw request would.
    expect(
      shouldStartCrossfade(trigger({ currentTime: 170, requestedSeconds: 12, nextDuration: 10 })),
    ).toBe(false)
    expect(
      shouldStartCrossfade(trigger({ currentTime: 176, requestedSeconds: 12, nextDuration: 10 })),
    ).toBe(true)
  })
})

/**
 * A fade the app is not awake to run — no longer refused (#455 → #470).
 *
 * `shouldStartCrossfade` used to take an `appActive` flag and answer false
 * without it, because **React Native stops firing JS timers while the Android
 * activity is paused** (`JavaTimerManager`: `onHostPause()` clears the frame
 * callback and `TimerFrameCallback.doFrame` returns early *without re-posting
 * itself*). The ramp was a `setInterval` and the incoming deck starts at gain 0
 * for it to raise, so a fade begun while backgrounded played the next track at
 * volume zero until the app came back.
 *
 * The ramp now has a second driver that survives the pause — `expo-audio`'s
 * status heartbeat, emitted from a Kotlin coroutine on `Dispatchers.Main`.
 * Measured on the device before the flag was removed, over 135 s backgrounded
 * with audio playing: `ticks=272 over=134582ms expected=269 playing=true`.
 *
 * `appIsActive` survives the flag's removal because the heartbeat *measurement*
 * still needs to know which window it is in.
 */
describe('the app being away no longer blocks a fade (#470)', () => {
  function trigger(overrides: Partial<CrossfadeTrigger> = {}): CrossfadeTrigger {
    return {
      currentTime: 175,
      duration: 180,
      nextDuration: 180,
      requestedSeconds: 8,
      hasNext: true,
      transitioning: false,
      isPlaying: true,
      ...overrides,
    }
  }

  /**
   * The behaviour change, stated as a test rather than as an absence.
   *
   * Deleting the two old cases would have left nothing asserting the new
   * answer, and "a guard proved only in the direction that blocks" is the #392
   * mistake in reverse.
   */
  it('starts a fade regardless of whether the app is in the foreground', () => {
    expect(shouldStartCrossfade(trigger())).toBe(true)
  })

  it('still refuses for every reason that is not the app being away', () => {
    expect(shouldStartCrossfade(trigger({ isPlaying: false }))).toBe(false)
    expect(shouldStartCrossfade(trigger({ hasNext: false }))).toBe(false)
    expect(shouldStartCrossfade(trigger({ transitioning: true }))).toBe(false)
    expect(shouldStartCrossfade(trigger({ requestedSeconds: 0 }))).toBe(false)
  })

  it('treats a known background state as away, and nothing else', () => {
    expect(appIsActive('background')).toBe(false)
    expect(appIsActive('inactive')).toBe(false)
    expect(appIsActive('active')).toBe(true)
    /*
     * `undefined` is the **test environment**, not a phone. `AppState
     * .currentState` is undefined under jest, so asking `=== 'active'` would
     * make every test here run the backgrounded path and this whole file would
     * assert nothing about the feature it names. Same reasoning, and the same
     * shape, as `worthMeasuring`.
     */
    expect(appIsActive(undefined)).toBe(true)
  })
})

/**
 * The instrument that decides whether #470 is a JavaScript change or a native
 * module — and specifically that it can print **both** answers.
 *
 * `docs/lessons.md` records three instruments in this project that could only
 * ever produce one result: #371's `running=false` sampled on the line after an
 * asynchronous start, #303's boolean that meant five different things, and
 * #396's probe built out of the very timer it was measuring. So the half that
 * matters most here is the dead-heartbeat case.
 */
describe('heartbeatReport (#470)', () => {
  it('reports a living heartbeat against what a live one would have produced', () => {
    expect(heartbeatReport({ since: 1_000, count: 6 }, 4_000, true)).toBe(
      'ticks=6 over=3000ms expected=6 playing=true',
    )
  })

  it('can report a dead heartbeat, which is the answer that sends #470 native', () => {
    expect(heartbeatReport({ since: 1_000, count: 0 }, 5_000, true)).toBe(
      'ticks=0 over=4000ms expected=8 playing=true',
    )
  })

  /** `since === 0` separates "never backgrounded" from "backgrounded and heard
   *  nothing" — a bare count of 0 runs the two together, and the difference is
   *  the whole measurement. */
  it('says nothing when the app never left', () => {
    expect(heartbeatReport({ since: 0, count: 0 }, 9_999, true)).toBeNull()
  })

  it('says nothing about a glance at the task switcher', () => {
    expect(heartbeatReport({ since: 1_000, count: 1 }, 1_900, true)).toBeNull()
  })

  /** The boundary is worth pinning: exactly a second is a window, not a glance,
   *  and an off-by-one here silently discards the shortest real measurements. */
  it('reports a window of exactly the minimum', () => {
    expect(heartbeatReport({ since: 1_000, count: 2 }, 2_000, false)).toBe(
      'ticks=2 over=1000ms expected=2 playing=false',
    )
  })

  /** Carried because a paused app producing no heartbeats is not evidence of a
   *  frozen loop — `startUpdating` only emits `if (playing)`. Without this the
   *  reading could not be told apart from the failure it looks like. */
  it('carries whether anything was playing at all', () => {
    expect(heartbeatReport({ since: 1_000, count: 0 }, 5_000, false)).toContain('playing=false')
  })
})
