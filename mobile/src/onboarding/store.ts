import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * The inline gesture hints (#502).
 *
 * A tour is seen once and forgotten; a hint that sits where the gesture lives
 * is the thing that actually teaches. These are the two swipes — the highest
 * value and the least guessable of the six interactions the issue lists.
 */
export type HintId = 'swipeToQueue' | 'swipeToRemove'

/**
 * Whether the first-run tour has been seen (#323).
 *
 * The web's `frontend/src/onboarding/store.ts` is the same idea and this is
 * deliberately its mirror — same `completed` flag, same `complete`/`reset`, and
 * the same i18n catalogue drives both. Two things had to change, and only one of
 * them is obvious.
 *
 * ## The obvious one: AsyncStorage
 *
 * `persist` defaults to `localStorage`, which does not exist here.
 *
 * ## The one that would have shipped a bug: rehydration is asynchronous
 *
 * `localStorage` is synchronous, so the web can render `{!completed && <Tour/>}`
 * the moment it mounts and be right. AsyncStorage is not: `completed` is `false`
 * for the first frames of **every** launch, including for someone who finished
 * the tour months ago. A direct port therefore flashes the tour on every cold
 * start and only dismisses it once storage answers.
 *
 * This is the same shape as #188, where the install id was read the same way and
 * every cold start sent its opening requests without one. So the store says
 * whether it has heard from storage yet, and nothing renders the tour until it
 * has. `false` here means "do not know", not "not completed" — the distinction
 * the web never has to make.
 */
interface OnboardingStore {
  /** Whether the first-run tour has been finished or skipped. */
  completed: boolean
  /** Whether storage has answered. Until it has, `completed` means nothing. */
  hydrated: boolean
  /**
   * Hints already learned or dismissed. Absent means "not yet", which is why
   * this is a set of the *done* ones rather than of the pending ones: a hint
   * added later starts hidden for nobody, including someone who has used the
   * app for months.
   */
  dismissedHints: Partial<Record<HintId, true>>
  complete: () => void
  /** Retire a hint for good. Idempotent — the gesture may fire many times. */
  dismissHint: (id: HintId) => void
  /** Re-arm the tour, from the "show again" control in Settings. */
  reset: () => void
}

export const useOnboarding = create<OnboardingStore>()(
  persist(
    (set) => ({
      completed: false,
      hydrated: false,
      dismissedHints: {},
      complete: () => set({ completed: true }),
      dismissHint: (id) =>
        set((state) =>
          state.dismissedHints[id]
            ? state
            : { dismissedHints: { ...state.dismissedHints, [id]: true } },
        ),
      // Replaying the tour re-arms the hints too. They are the same lesson
      // taught twice, and "show me the introduction again" plainly means all of
      // it — leaving them dismissed would replay the half that does not teach.
      reset: () => set({ completed: false, dismissedHints: {} }),
    }),
    {
      name: 'mio-onboarding',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      // Fires whether or not there was anything stored, and on failure too —
      // which is what makes it safe to gate rendering on. A flag set only on a
      // successful read would leave a first-ever launch, where there is nothing
      // to read, waiting forever and never showing the tour at all.
      onRehydrateStorage: () => () => {
        useOnboarding.setState({ hydrated: true })
      },
      // `hydrated` is derived from storage rather than stored in it: persisting
      // it would write `true` and then read it back on the next launch before
      // the read had actually happened, which is the bug this exists to stop.
      // `version` is deliberately unchanged by #502's new field. zustand's
      // default merge is shallow — a stored `{ completed: true }` overrides only
      // `completed` and `dismissedHints` keeps its initial `{}` — so an existing
      // install needs no migration and simply starts with the hints armed,
      // which is the correct answer for someone who has never seen them.
      partialize: (state) => ({
        completed: state.completed,
        dismissedHints: state.dismissedHints,
      }),
    },
  ),
)

/**
 * Whether to show the tour right now.
 *
 * A named function rather than `hydrated && !completed` inline in the layout,
 * because the interesting half is invisible at the call site: **not knowing yet
 * is not the same as not having seen it.** Written inline, the `hydrated` term
 * reads like a redundant guard someone could delete during a tidy-up, and the
 * cost of deleting it — a tour that flashes on every cold start — would not show
 * up in any test that did not exist to catch it. Here it can be tested.
 */
export function shouldShowTour(state: Pick<OnboardingStore, 'completed' | 'hydrated'>): boolean {
  if (!state.hydrated) return false
  return !state.completed
}

/**
 * Whether to show a given inline hint right now (#502).
 *
 * The same `hydrated` reasoning as `shouldShowTour`, and for a sharper reason:
 * a hint that flashes onto the library for two frames on every cold start is
 * worse than one that never appears, because it draws the eye to something that
 * has already gone by the time it is looked at.
 *
 * It also must not compete with the tour. Both visible at once is two overlays
 * saying the same thing, and the modal is on top, so the hint would be teaching
 * a gesture the user cannot reach.
 */
export function shouldShowHint(
  state: Pick<OnboardingStore, 'completed' | 'hydrated' | 'dismissedHints'>,
  id: HintId,
): boolean {
  if (!state.hydrated) return false
  if (!state.completed) return false
  return !state.dismissedHints[id]
}
