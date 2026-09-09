import { create } from 'zustand'

/**
 * The text another app shared into MiO, waiting for the Add-link screen (#573).
 *
 * ## Why a store and not a route parameter
 *
 * A share arrives at the **root**: as the launch intent on a cold start, and
 * through `onNewIntent` on a warm one. The root layout is the only place that
 * can hear both and the only place that can navigate — but `add/link` has no
 * params, and giving it one would put the shared text in the URL, where
 * `expo-router` keeps it across a re-render and a back-navigation. The user
 * would then see the same link pre-filled every time they returned to the
 * screen.
 *
 * A store makes it explicitly one-shot: the root puts it in, the screen takes
 * it out, and nothing holds it afterwards.
 *
 * Deliberately **not** persisted. A share is about this moment; one surviving a
 * restart would pre-fill a link the user shared days ago and had forgotten.
 */
interface SharedTextState {
  /** Waiting to be consumed, or null. */
  pending: string | null
  offer: (text: string) => void
  /** Read it and clear it. Null when there is nothing waiting. */
  take: () => string | null
}

export const useSharedText = create<SharedTextState>()((set, get) => ({
  pending: null,
  offer: (text) => set({ pending: text }),
  take: () => {
    const { pending } = get()
    if (pending !== null) set({ pending: null })
    return pending
  },
}))

/**
 * Whether the Add-link screen is the route already showing (#600).
 *
 * ## Why the root has to ask
 *
 * A share is delivered to the root, which then navigates. When Add-link is
 * *already* the current route, `offer` alone is the whole job: the mounted
 * screen re-renders, applies the text and empties the store. Pushing as well
 * mounts a **second** Add-link — `url` empty, `applied` null — over the filled
 * one, and by then there is nothing left in the store for it to read. The user
 * sees an empty box and concludes the share was dropped; it is underneath.
 *
 * Measured before the fix: three shares in a row needed three back-presses to
 * leave the screen.
 *
 * Matched on the tail rather than the whole path, because the route sits under
 * a group (`(tabs)`) and a group can be renamed or added without changing which
 * screen this is.
 */
export function isOnAddLink(segments: readonly string[]): boolean {
  return segments.at(-2) === 'add' && segments.at(-1) === 'link'
}

/** Test seam: the store is module state and outlives a test. */
export function resetSharedText(): void {
  useSharedText.setState({ pending: null })
}
