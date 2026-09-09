import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface OnboardingStore {
  /** Whether the first-run tour has been finished or skipped. */
  completed: boolean
  complete: () => void
  /** Re-arm the tour, e.g. from the "show again" control in Settings. */
  reset: () => void
}

export const useOnboardingStore = create<OnboardingStore>()(
  persist(
    (set) => ({
      completed: false,
      complete: () => set({ completed: true }),
      reset: () => set({ completed: false }),
    }),
    { name: 'mio-onboarding', version: 1 },
  ),
)
