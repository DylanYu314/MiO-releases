/**
 * Noticing that a run paused while the app was away (#430).
 *
 * ## Why a message rather than a fix
 *
 * #371 built a `dataSync` foreground service to stop Android freezing a
 * minimised import, and the device pass could not show it working. My call
 * on 2026-08-10 was that background imports are not worth more effort: a run
 * resumes from where it stopped (#369), so the cost is a minute of somebody's
 * attention rather than a lost download.
 *
 * The screen has said *"keep this screen open"* ever since. That is a warning
 * given **before** anything happens, and my 2026-08-09 report was that
 * nothing says anything when it actually does — you come back, the bar is where
 * you left it, and the app knows why and does not mention it.
 *
 * ## Why the decision is here and not in the screen
 *
 * Because it is the part that can be wrong. Telling someone their import paused
 * when it did not is worse than saying nothing: the next time it is true they
 * will not believe it. So the rule is written where a test can hand it every
 * case, in the same shape as `crossfade.ts` and `backgroundStart.ts`.
 */

/** What was true when the app went away. */
export interface AwaySpan {
  /** Tracks finished at the moment of leaving. */
  done: number
  /** When the app left, in wall-clock milliseconds. */
  at: number
}

/**
 * How long away is long enough to draw a conclusion from.
 *
 * Eight seconds. A track takes appreciably longer than that to fetch even on a
 * good connection, so a shorter trip — glancing at a notification, taking a
 * photo — legitimately lands between two increments and proves nothing. Below
 * this the honest answer is "no evidence", not "it paused".
 */
export const MIN_AWAY_MS = 8_000

/**
 * Whether returning from the background is worth telling the user about.
 *
 * True only when the app was away long enough for progress to have been
 * expected **and** none was made. Every other combination stays quiet:
 *
 * | away | progress | says |
 * |---|---|---|
 * | long | none | it paused — the case this exists for |
 * | long | some | nothing: it kept working, which is the good outcome |
 * | short | none | nothing: too brief to be evidence of anything |
 */
export function pausedWhileAway(span: AwaySpan | null, doneNow: number, now: number): boolean {
  if (span === null) return false
  if (now - span.at < MIN_AWAY_MS) return false
  return doneNow <= span.done
}
