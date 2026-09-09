import { useEffect, useState } from 'react'

import { logInfo } from './log'

/**
 * How long a screen took to mount, and **which open this was** (#503).
 *
 * from the device: *"Queue panel open a little slow, little long to
 * respond, anyway to make it open faster? like cache the queue?"*
 *
 * ## This measures rather than fixes, on purpose
 *
 * Caching is not the fix and there is nothing to cache — `app/queue.tsx` reads
 * only the in-memory player store, with no database read and no request. The
 * cost is *mounting*, and the issue lists four candidates. Performance work is
 * halted pending my Performance Monitor pass, and *"a little slow"* is
 * exactly the vague instrument `docs/lessons.md` warns about, so the useful
 * thing to ship is the number rather than a guess at which candidate it is.
 *
 * ## What each answer would mean
 *
 * The question that decides it is **is the second open much faster than the
 * first**, and `open=` is what answers it:
 *
 * | reading | conclusion |
 * |---|---|
 * | `open=1` slow, `open=2` fast | first-mount cost — the renderer, StyleSheet registry and i18n initialising. **Nothing to fix in the screen.** |
 * | both slow, and rising with the counts | the two `DraggableList`s, or the lack of windowing |
 * | both slow, flat in the counts | the route transition, not the content |
 * | only ever `open=1`, still slow the second time | the screen is being *kept* mounted, so mounting is not the cost at all |
 *
 * The last row is why the absence of a second line is itself a reading, and it
 * is the reason this counts opens rather than simply timing one.
 *
 * ## Why it can print the other answer
 *
 * The instrument that measures nothing is the one that could only ever have
 * printed the result it printed — #371's `running=false`, sampled on the line
 * after an asynchronous call. This one is two subtractions across a real mount,
 * so a fast mount reports a small number and a slow one reports a large one.
 *
 * It also does not share a failure mode with its subject: the app is
 * foregrounded and actively rendering while this runs, which is exactly the
 * condition `queue.backgroundStart` could not rely on.
 *
 * ## `Date.now`, not `performance.now`
 *
 * Jest has `performance`; asserting Hermes does is the shape of mistake that
 * shipped an app which would not open. Milliseconds are ample here — the
 * question is 60 against 600, not 60.2 against 60.4.
 */

/** Opens per screen, for this launch only. Module-level, so it resets with the
 *  process — which is the scope the question is about. */
const opensThisLaunch = new Map<string, number>()

/** Tests share a module registry; without this, counts leak between them. */
export function resetMountCounts(): void {
  opensThisLaunch.clear()
}

/**
 * Format the line, separately from taking the measurement.
 *
 * Pure, so the wording can be tested without mounting anything — and so the
 * detail is visibly *varying*. The log de-duplicates an immediate repeat with an
 * identical detail (#371), and a fixed string here would erase the second open,
 * which is the one reading the whole exercise is for.
 */
export function formatMountSample(
  open: number,
  toCommitMs: number,
  toFrameMs: number,
  detail: string,
): string {
  return `open=${open} toCommit=${Math.round(toCommitMs)}ms toFrame=${Math.round(toFrameMs)}ms ${detail}`
}

/**
 * Time this component's first mount and log it once.
 *
 * `detail` should be counts and never titles — `scrub()` catches URLs and
 * nothing can catch a song name (#354).
 */
export function useMountTiming(screen: string, detail: string): void {
  // A lazy `useState` initialiser, not a ref written during render: the clock
  // has to start when this render started — or the render itself falls outside
  // the window being measured — and touching a ref there is the thing React's
  // lint rule forbids outright.
  const [began] = useState(() => Date.now())

  useEffect(() => {
    const toCommit = Date.now() - began

    // Counted at commit rather than during render, so it increments exactly
    // once per mount however many times React chooses to render.
    const open = (opensThisLaunch.get(screen) ?? 0) + 1
    opensThisLaunch.set(screen, open)

    // `detail` is captured from the first render on purpose. This samples the
    // *first* mount, so the counts as they were when that mount started are the
    // ones that belong in the line.
    const report = () => {
      logInfo(`${screen}.mount`, formatMountSample(open, toCommit, Date.now() - began, detail))
    }

    // After commit is not yet after paint, and the gap is where the layout of
    // two draggable lists actually lands. A frame callback gets the nearer
    // number; if the runtime has none, the commit time alone is still an answer.
    if (typeof requestAnimationFrame !== 'function') {
      report()
      return
    }
    requestAnimationFrame(report)

    // **No cleanup, deliberately.** Cancelling the frame on unmount is the
    // reflex, and it silently drops the sample for any mount that ends within
    // one frame — which is precisely the fast case this exists to detect. The
    // first version did cancel, and a test that opened the screen twice saw
    // only `open=2`: the reading the issue turns on had been thrown away by the
    // instrument's own tidiness. Writing a line after unmount costs nothing —
    // `logInfo` appends to a store, touches no unmounted component, and cannot
    // throw.
    // Once per mount. `screen` is a literal at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
