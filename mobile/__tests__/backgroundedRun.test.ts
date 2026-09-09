import { MIN_AWAY_MS, pausedWhileAway } from '../src/library/backgroundedRun'

/**
 * Saying an import paused while the app was away (#430).
 *
 * The screen has always warned *in advance* that a minimised import stops.
 * My 2026-08-09 report was that nothing says anything when it actually
 * does: you come back, the bar is exactly where you left it, and the app knew
 * why and did not mention it.
 *
 * The rule is separate from the screen because it is the part that can be
 * wrong. A false claim is worse than silence — the next time it is true, nobody
 * believes it — so the interesting cases are the ones where it must stay quiet.
 */

const LEFT_AT = 1_000_000

describe('deciding that a run paused while the app was away', () => {
  it('says so when the app was away a while and nothing finished', () => {
    expect(pausedWhileAway({ done: 12, at: LEFT_AT }, 12, LEFT_AT + MIN_AWAY_MS)).toBe(true)
  })

  it('stays quiet when tracks landed while the app was away', () => {
    // The good outcome, and the one a foreground service is supposed to give.
    // Warning here would be the app calling its own success a failure.
    expect(pausedWhileAway({ done: 12, at: LEFT_AT }, 15, LEFT_AT + 60_000)).toBe(false)
  })

  it('stays quiet after a trip too short to prove anything', () => {
    // Glancing at a notification. A track takes appreciably longer than this to
    // fetch, so no progress across it is not evidence of a pause — it is the
    // ordinary gap between two increments.
    expect(pausedWhileAway({ done: 12, at: LEFT_AT }, 12, LEFT_AT + MIN_AWAY_MS - 1)).toBe(false)
  })

  it('says nothing when the app was never away', () => {
    expect(pausedWhileAway(null, 12, LEFT_AT)).toBe(false)
  })

  it('counts a number that went backwards as no progress, not as progress', () => {
    // The condition is "nothing finished", so it has to be `<=` rather than
    // `===`. A retry does reset the count (#398) — but only a button press
    // starts one, which needs the app in the foreground, so it cannot happen
    // *while* away. This pins the arithmetic rather than a scenario.
    expect(pausedWhileAway({ done: 40, at: LEFT_AT }, 1, LEFT_AT + 60_000)).toBe(true)
  })
})
