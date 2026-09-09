import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/**
 * Where playback had reached, so reopening returns to the same second (#183).
 *
 * ## Why this is not in `usePlayer`, which is where it started
 *
 * It is written **every five seconds for as long as anything is playing** — the
 * one value in this app on a timer rather than on a user action. `usePlayer` is
 * `persist`-wrapped, and zustand's persist middleware serialises the whole
 * partialized state on every change, so each of those writes was re-serialising
 * `contextQueue`: every song in the list you are playing from.
 *
 * Measured, on the shape of a real library row (E3, #342):
 *
 * | context | written per 5 s |
 * |---|---|
 * | 50 songs | 48 KB |
 * | 200 songs | 119 KB |
 * | 500 songs | 260 KB |
 * | 1000 songs | 496 KB |
 *
 * A quarter of a megabyte through the AsyncStorage bridge, twelve times a
 * minute, for a value nothing reads until the next launch — and it grows with
 * the library, which is exactly the condition #342 reports the lag under
 * ("large library, several playlists") and exactly why it **persists after an
 * import finishes**: the library is bigger now.
 *
 * Splitting it out costs nothing and makes the periodic write about fifty bytes.
 * The big payload still persists, but only when the queue genuinely changes — a
 * track ending, a tap, a drag — which is user-paced rather than clock-paced.
 *
 * ## What this is not
 *
 * It is **not** a claim that this was the lag. That needs a device (#368). It is
 * a periodic cost that scales with library size, removed for the price of a
 * small file, which is worth doing whether or not it turns out to be the
 * headline.
 */
export interface ResumePoint {
  songId: string | number
  seconds: number
}

interface ResumeStore {
  /**
   * Keyed by song id so it is self-invalidating — a position can only ever be
   * applied to the track it was taken from, and no queue transition has to
   * remember to clear it.
   */
  point: ResumePoint | null
  set: (songId: string | number, seconds: number) => void
  clear: () => void
}

export const useResume = create<ResumeStore>()(
  persist(
    (set) => ({
      point: null,
      set: (songId, seconds) => set({ point: { songId, seconds } }),
      clear: () => set({ point: null }),
    }),
    {
      // A separate key from `mio-player`, so the two cannot rewrite each other.
      name: 'mio-resume',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
)
