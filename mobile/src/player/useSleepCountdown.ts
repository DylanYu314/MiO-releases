import { useEffect, useState } from 'react'

import { usePlayer } from './store'

/**
 * How long the sleep timer has left, ticking (#314).
 *
 * ## Why a hook rather than a formatted string in each screen
 *
 * Two places show it — the queue's chip and the playing panel's options sheet —
 * and both showed an **absolute clock time** that never moved: `sleepAt` is a
 * fixed number and neither component held a timer, so "sleeps at 23:14" was
 * static from arming until firing. A timer set for under a minute showed the
 * current minute, which reads as "sleeping now" and is not what it means.
 *
 * A countdown has to tick, and a tick is a subscription. Doing that twice, in
 * two components, is two chances to leave an interval running.
 *
 * ## Whole seconds, and one interval
 *
 * It re-renders its host once a second and no faster: nothing here is
 * sub-second, and a 60 Hz countdown would repaint a list for a digit that has
 * not changed. The interval only exists while a timer is armed — an app with no
 * sleep timer set starts nothing.
 *
 * `sleepAfterTrack` deliberately returns null: "at the end of this track" has no
 * clock reading at all, and inventing one from the track's remaining time would
 * be a different promise (the queue can change under it).
 */
export function useSleepCountdown(): number | null {
  const sleepAt = usePlayer((state) => state.sleepAt)
  const sleepAfterTrack = usePlayer((state) => state.sleepAfterTrack)
  const armed = !sleepAfterTrack && sleepAt !== null

  /*
   * A clock sample, moved by the interval — not the countdown itself.
   *
   * The remaining time is *derived* from it during render, which is what lets
   * arming a new timer show the right number immediately instead of the old
   * one until the next tick. Writing the countdown into state from the effect
   * would also be a `setState` in an effect body, which this project's lint
   * rules refuse, rightly.
   */
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!armed) return
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [armed, sleepAt])

  if (!armed || sleepAt === null) return null
  return Math.max(0, Math.round((sleepAt - now) / 1000))
}
