import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

/**
 * Lets a scroll container tell its descendants what is on screen (#503).
 *
 * ## Why a subscription rather than a prop
 *
 * The queue screen renders every row of the context queue, and with ~135 of
 * them the screen took `toCommit=475ms toFrame=775ms` to open. The fix is to
 * mount only the rows near the viewport, which means a list has to know where
 * the viewport is.
 *
 * Holding the scroll offset in the screen's state would achieve that and undo
 * most of it: every scroll event would re-render the whole screen, including
 * all the rows the windowing exists to avoid mounting. So the offset lives in a
 * ref and is **pushed** to whoever asked for it. A `DraggableList` then
 * re-renders only when its own window of rows actually changes — which is once
 * every half-screen of scrolling, not once per frame.
 *
 * ## The contract
 *
 * The container spreads `onScroll`/`onLayout` onto its `ScrollView` (with
 * `scrollEventThrottle`) and wraps its subtree in {@link ScrollWindowProvider}.
 * Anything below can then call {@link useScrollWindow}. **Nothing is required
 * to**: without a provider `useScrollWindow` returns `null` and a list renders
 * in full, which is what keeps the playlist screen and every existing test
 * unchanged.
 */

/** What is currently visible: how far the container is scrolled, and how tall
 *  it is. Both in the scroll view's own coordinate space. */
export interface Viewport {
  scrollY: number
  height: number
}

type Listener = (viewport: Viewport) => void

export interface ScrollWindowSource {
  /** Called immediately with the current viewport, then on every change.
   *  Returns an unsubscribe. */
  subscribe: (listener: Listener) => () => void
  /** The viewport right now, for a caller that needs it outside a subscription
   *  — a list that has just been laid out and cannot wait for the next scroll. */
  read: () => Viewport
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  onLayout: (event: LayoutChangeEvent) => void
}

const ScrollWindowContext = createContext<ScrollWindowSource | null>(null)

/**
 * Create the source. Belongs to the component that owns the `ScrollView`.
 *
 * Stable across renders, so subscribing does not re-run on every parent render.
 */
export function useScrollWindowSource(): ScrollWindowSource {
  const viewport = useRef<Viewport>({ scrollY: 0, height: 0 })
  const listeners = useRef<Set<Listener>>(new Set())

  const publish = useCallback((next: Viewport) => {
    viewport.current = next
    for (const listener of listeners.current) listener(next)
  }, [])

  return useMemo(
    () => ({
      subscribe: (listener: Listener) => {
        listeners.current.add(listener)
        // Immediately, because a list that mounts mid-scroll would otherwise
        // show its initial window until the next scroll event.
        listener(viewport.current)
        return () => {
          listeners.current.delete(listener)
        }
      },
      read: () => viewport.current,
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) =>
        publish({ ...viewport.current, scrollY: event.nativeEvent.contentOffset.y }),
      onLayout: (event: LayoutChangeEvent) =>
        publish({ ...viewport.current, height: event.nativeEvent.layout.height }),
    }),
    [publish],
  )
}

export function ScrollWindowProvider({
  source,
  children,
}: {
  source: ScrollWindowSource
  children: ReactNode
}) {
  return <ScrollWindowContext.Provider value={source}>{children}</ScrollWindowContext.Provider>
}

/** The enclosing scroll container's viewport, or `null` when there is none. */
export function useScrollWindow(): ScrollWindowSource | null {
  return useContext(ScrollWindowContext)
}

/**
 * Which rows a list of uniform-height rows needs to have mounted.
 *
 * `listY` is the list's own offset inside the scrolled content, so
 * `scrollY - listY` is how far into *this list* the viewport starts. Returns a
 * half-open range, clamped to the list.
 *
 * `overscan` rows are kept on each side so a fling does not expose a gap before
 * the next window is computed. It is why this is worth a pure function: the
 * arithmetic is off-by-one bait, and it is the only part of #503 a test can
 * check without a layout engine — jest performs no layout, which is the trap
 * that shipped a marquee that never moved (#306).
 */
export function windowFor(
  scrollY: number,
  viewportHeight: number,
  listY: number,
  rowHeight: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  const clamp = (value: number) => Math.min(Math.max(value, 0), count)
  const top = scrollY - listY
  const start = clamp(Math.floor(top / rowHeight) - overscan)
  const end = clamp(Math.ceil((top + viewportHeight) / rowHeight) + overscan)
  // A viewport that has not been measured yet reports height 0, which would
  // window everything away and paint an empty list. Falling back to the whole
  // list means the first frame is the old behaviour, never a blank one.
  if (viewportHeight <= 0) return { start: 0, end: count }
  return { start, end: Math.max(start, end) }
}
