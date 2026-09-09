import { usePathname, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef } from 'react'

/**
 * One navigation per press, however many presses arrive (#375).
 *
 * ## The bug is in the queue, and it is not a slow phone
 *
 * two taps in quick succession open two screens, the first immediately
 * covered by the second — "both page will load and ????".
 *
 * Read out of `expo-router@57`'s own source rather than reasoned about:
 * `router.push` does **not** navigate. `push` → `linkTo` → `routingQueue.add`,
 * which appends the action to an array and notifies subscribers.
 * `useImperativeApiEmitter` then flushes that queue **in a `useEffect`**,
 * dispatching every action it finds:
 *
 * ```js
 * // expo-router/build/global-state/routingQueue.js
 * run(ref) {
 *   const events = routingQueue.queue
 *   routingQueue.queue = []
 *   while ((action = events.shift())) { ... ref.current.dispatch(action) }
 * }
 * ```
 *
 * So every press between the first one and the next effect flush is a separate
 * dispatch, and two dispatches are two screens. Nothing in that path dedupes.
 *
 * **A release build will not fix it.** It narrows the window — that is the whole
 * of the difference — but the window is a render cycle, not a fixed duration,
 * and a busy frame reopens it. This is a correctness bug, and independent of
 * #367.
 *
 * ## Why the lock is released by the *path*, not by a timer
 *
 * A plain debounce ("ignore anything within 700 ms") swallows a genuine second
 * navigation — land on a screen, immediately press onward — and swallowing a
 * real press is the same complaint this is meant to fix, arriving from the
 * other direction.
 *
 * So the lock is held until `usePathname()` reports this screen's **own path
 * again** — one navigation per visit. There is no interval to tune, and nothing
 * to retune per screen.
 *
 * **Releasing on any path change was the first attempt and it was wrong**, which
 * a device found and the tests did not (#375, reopened after #392). The path
 * changes the instant the action is dispatched, while the source screen is still
 * mounted and still taking touches under the push animation — so the lock came
 * back before the second tap did.
 *
 * `TRAPPED_LOCK_MS` only exists so a dropped navigation cannot leave a button
 * permanently dead — a push whose path never changes (the same route pushed
 * onto itself, or an action dropped because the navigator was not mounted)
 * would otherwise hold the lock until the screen unmounted. It is a backstop
 * and deliberately far longer than any real navigation, so it never becomes the
 * mechanism by accident.
 *
 * ## `usePathname` and nothing else
 *
 * An earlier draft also re-armed on a React Navigation `focus` event. It was
 * removed for a reason worth keeping: `useNavigation()` throws outside a
 * `NavigationContainer`, which made this hook — and every screen using it —
 * impossible to render without one. The plain router has no such requirement,
 * and three suites that render a screen directly failed the moment it was added.
 *
 * What it was reaching for is now done by the path itself: the lock is released
 * when this screen's own path comes back, which is what "focused again" means
 * without needing a navigator to say so.
 *
 * ## What this does not cover, and why that is not an oversight
 *
 * **The tab bar.** Two tab presses do not stack, and cannot: `BottomTabBar`
 * dispatches `CommonActions.navigate(route)` straight at the navigator rather
 * than through `routingQueue`, so pressing two tabs lands on the second one —
 * which is correct. Both screens *rendering* on the way is rendering cost
 * (#372, #373), not navigation, and no guard here would change it.
 *
 * **`app/_layout.tsx`'s `router.replace('/setup')`.** It is an effect deciding
 * where a launch belongs, not a press. Guarding it would risk swallowing the
 * one navigation nobody can retry by pressing again.
 */

/** How long a lock may survive a navigation that never lands. Long enough that
 *  it can never pre-empt the pathname release, short enough that a wedged
 *  button heals without the screen having to be left. */
const TRAPPED_LOCK_MS = 2000

export interface GuardedRouter {
  push: (href: string) => void
  replace: (href: string) => void
  back: () => void
}

export function useGuardedRouter(): GuardedRouter {
  const router = useRouter()
  const pathname = usePathname()
  const locked = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Where this screen was when it last navigated — the path to come home to. */
  const from = useRef<string | null>(null)

  const release = useCallback(() => {
    locked.current = false
    from.current = null
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  /*
   * Released on **coming back**, not on leaving.
   *
   * The first version released whenever `pathname` changed, which sounded like
   * "the navigation landed" and was too early by the whole of the push
   * animation: the source screen is still mounted, still on screen and still
   * taking touches while the new one slides over it. A second tap ~200 ms later
   * found the lock already given back and opened a second screen — which is
   * #375 reported a second time, against the build that was supposed to fix it.
   *
   * Waiting for the path to come *home* makes it one navigation per visit. Going
   * away holds the lock however long you are gone; returning re-arms it.
   */
  useEffect(() => {
    if (from.current !== null && pathname === from.current) release()
  }, [pathname, release])

  useEffect(() => release, [release])

  const guard = useCallback(
    (go: () => void) => {
      if (locked.current) return
      locked.current = true
      from.current = pathname
      // Set before `go`, not after: `push` is synchronous up to the queue, and a
      // second press can arrive before anything else on this line runs.
      timer.current = setTimeout(() => {
        locked.current = false
        from.current = null
        timer.current = null
      }, TRAPPED_LOCK_MS)
      go()
    },
    [pathname],
  )

  return {
    push: useCallback((href: string) => guard(() => router.push(href)), [guard, router]),
    replace: useCallback((href: string) => guard(() => router.replace(href)), [guard, router]),
    back: useCallback(() => guard(() => router.back()), [guard, router]),
  }
}
