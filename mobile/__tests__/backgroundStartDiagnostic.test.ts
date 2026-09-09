/**
 * The diagnostic for #396 must be able to give **all three answers** (#396).
 *
 * *"i can see the next track is started playing from lock screen, but no
 * audio. only when i open the app, audio regained"*. Reading `expo-audio`
 * produced three candidates and could not separate them — a foreground-service
 * window during `setActiveForLockScreen`, audio focus, or a deck left at a gain
 * near zero by a fade that never ran.
 *
 * So the next device pass has to separate them, and that only works if the
 * instrument can actually print each answer. **#371 shipped a diagnostic that
 * could only ever print one value** (`running=false`, sampled before an async
 * call could complete) and it was mistaken for a finding. The lesson written
 * from it is the one under test here: *ask what the diagnostic would print if
 * the code were healthy — if that is the same thing, the reading is noise.*
 *
 * This exercises `describeBackgroundStart`, the pure half, for exactly that.
 */
import { describeBackgroundStart, worthMeasuring } from '../src/player/backgroundStart'

describe('the background-start diagnostic', () => {
  it('says the start was refused when the deck is not playing', () => {
    const line = describeBackgroundStart({
      deck: 1,
      state: 'background',
      gain: 1,
      volume: 1,
      startedAt: 0,
      now: 0,
      playing: false,
    })

    expect(line).toMatch(/playing=false/)
    // Candidates 1 and 2 — the foreground-service window, or audio focus.
    expect(line).toMatch(/advanced=false/)
  })

  it('says it is playing and the clock is moving, which points at the gain', () => {
    const line = describeBackgroundStart({
      deck: 0,
      state: 'background',
      gain: 0,
      volume: 0,
      startedAt: 10,
      now: 12,
      playing: true,
    })

    // Candidate 3: it really is playing, and the gain is why nobody hears it.
    expect(line).toMatch(/playing=true/)
    expect(line).toMatch(/advanced=true/)
    expect(line).toMatch(/gain=0\.00/)
  })

  it('distinguishes a frozen clock from a moving one', () => {
    const frozen = describeBackgroundStart({
      deck: 0,
      state: 'background',
      gain: 1,
      volume: 1,
      startedAt: 10,
      now: 10,
      playing: true,
    })

    expect(frozen).toMatch(/playing=true/)
    expect(frozen).toMatch(/advanced=false/)
  })

  /**
   * The #371 guard, stated as a test.
   *
   * If every one of the cases above produced the same string, this instrument
   * would be worthless in exactly the way that one was — and nothing else in
   * the suite would say so.
   */
  it('prints a different answer for each of the three states', () => {
    const base = { deck: 0 as const, state: 'background', volume: 1, startedAt: 10 }
    const lines = new Set([
      describeBackgroundStart({ ...base, gain: 1, now: 10, playing: false }),
      describeBackgroundStart({ ...base, gain: 1, now: 10, playing: true }),
      describeBackgroundStart({ ...base, gain: 0, now: 12, playing: true }),
    ])

    expect(lines.size).toBe(3)
  })

  it('says so rather than guessing when the deck reports no clock', () => {
    // The mock lacked `currentTime` and the first version of this threw. A
    // diagnostic that cannot read something must report that it could not,
    // never a default that reads as a measurement.
    const line = describeBackgroundStart({
      deck: 0,
      state: 'background',
      gain: 1,
      volume: 1,
      startedAt: null,
      now: null,
      playing: true,
    })

    expect(line).toMatch(/advanced=unknown/)
    expect(line).not.toMatch(/advanced=(true|false)/)
  })

  /**
   * The signature I reported on 2026-08-11, which is now the expected one.
   *
   * He reopened the app mid-track and found the position at ~4 seconds — the
   * time it took me to open it. So the deck started, kept running, and was
   * simply inaudible. That eliminates the refusal candidate outright and makes
   * this the line the next device pass should produce.
   */
  it('prints the signature of a deck that played the whole time, unheard', () => {
    const line = describeBackgroundStart({
      deck: 0,
      state: 'background',
      gain: 1,
      volume: 1,
      startedAt: 0,
      now: 4,
      playing: true,
    })

    // Playing, clock moved, and **we did not silence it** — so the fault is
    // between the deck and the speaker, not in our gain.
    expect(line).toMatch(/playing=true/)
    expect(line).toMatch(/advanced=true/)
    expect(line).toMatch(/gain=1\.00/)
    expect(line).toMatch(/vol=1\.00/)
  })

  it("separates our own silence from someone else's", () => {
    const ourFault = describeBackgroundStart({
      deck: 0,
      state: 'background',
      gain: 0,
      volume: 0,
      startedAt: 0,
      now: 4,
      playing: true,
    })
    const notOurFault = describeBackgroundStart({
      deck: 0,
      state: 'background',
      gain: 1,
      volume: 1,
      startedAt: 0,
      now: 4,
      playing: true,
    })

    // Same `playing`/`advanced`; only the levels differ. Without reading the
    // volume back, these two would be one indistinguishable line — and they are
    // the difference between a bug in our gain and a bug in audio routing.
    expect(ourFault).not.toBe(notOurFault)
  })

  it('carries nothing about what the user is listening to (#354)', () => {
    const line = describeBackgroundStart({
      deck: 0,
      state: 'background',
      gain: 1,
      volume: 1,
      startedAt: 0,
      now: 1,
      playing: true,
    })

    expect(line).not.toMatch(/http/)
    // Deck index, app state, gain and clock. Nothing else has any business here.
    expect(line).toMatch(/^deck=0 /)
  })
})

/**
 * When it runs at all — the condition that broke CI (2026-08-11).
 *
 * The guard was `AppState.currentState !== 'active'`, which is true for
 * `undefined` — and `undefined` is exactly what jest reports, because the test
 * environment lacks a value the runtime always has. So every test that played a
 * track scheduled a two-second probe; a laptop finished the run before they
 * fired and CI, which is 4–7x slower, ran them inside later tests and failed a
 * run in which all 1092 tests passed.
 *
 * This is the inverse of the trap this repo's conventions records — usually the test
 * environment supplies an API the runtime lacks. Here it withheld a value the
 * runtime always has, and the code read the absence as a state.
 */
describe('the state that makes a start worth measuring', () => {
  it.each(['background', 'inactive'])('measures a start made while %s', (state) => {
    expect(worthMeasuring(state)).toBe(true)
  })

  it('ignores a start made while the app is in front, where the bug does not happen', () => {
    expect(worthMeasuring('active')).toBe(false)
  })

  it('ignores an unknown state rather than treating it as backgrounded', () => {
    // The whole of the CI failure, in one assertion.
    expect(worthMeasuring(undefined)).toBe(false)
    expect(worthMeasuring('')).toBe(false)
  })
})
