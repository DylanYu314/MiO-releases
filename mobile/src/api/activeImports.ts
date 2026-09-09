import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { isRetryable, isTerminal, type JobStatus } from './types'

/**
 * Which imports this device has started, and how they are getting on (#182).
 *
 * ## Why a store rather than screen state
 *
 * The add-a-link screen used to hold its job id in `useState`, with a comment
 * arguing that a phone has no URL to keep it in and the socket reconnects from
 * the id anyway. Both true, and both beside the point: leaving the screen
 * unmounted the component, so the id was gone. Coming back showed an empty form
 * while the download carried on invisibly, and pasting the link again started a
 * **second** import of the same track.
 *
 * The job itself was never lost — `ImportJob` is a row and `WS /jobs/{id}/ws`
 * will happily reconnect. What was lost was the client's knowledge of *which*
 * job to watch. So that knowledge moves somewhere with a longer life than a
 * screen.
 *
 * ## Why it is persisted
 *
 * A download outlives the app. Closing MiO mid-import and reopening it should
 * show the import still running, because on the server it is.
 *
 * Capped rather than unbounded: this is a recent-activity list, not history.
 * `GET /jobs` is the real record if one is ever wanted.
 */

/** Enough to be useful on the add screen; small enough that nobody scrolls it. */
const MAX_TRACKED = 20

export interface TrackedImport {
  jobId: number
  /** What was pasted, so a row means something before the title is known. */
  url: string
  /** Last status seen. `null` until the first update arrives. */
  status: JobStatus | null
  /**
   * Why it failed, as the backend's derived code (#222).
   *
   * Kept on the record because `inFlight` has to decide whether a *failed*
   * entry is still something the user is waiting on — an import about to be
   * retried is, and only the code says whether it will be.
   */
  errorCode?: string | null
  /**
   * Whether the audio has reached this device (#159).
   *
   * Separate from `status`, because they answer different questions: `done` means
   * the *server* finished, and this means the song is actually here. Under
   * local-first the second is the one that matters — a song the server has and
   * the phone does not is not in your library.
   */
  savedLocally: boolean
  startedAt: number
  /**
   * How many times this device has re-submitted the link on its own (#222).
   *
   * A transient failure should be our problem before it is the user's. Tracked
   * per record rather than globally so one unlucky link cannot spend another
   * link's budget, and persisted with the rest so a relaunch mid-retry does not
   * start the count again.
   */
  retries: number
}

/**
 * How many times to try again before asking the user to.
 *
 * Two, not more. The backend already retries transient extraction failures
 * inside the task (three attempts, exponential backoff), so this is the second
 * layer — and a link that has failed the backend's three attempts and two of
 * ours is not going to come good on a sixth.
 */
export const MAX_AUTO_RETRIES = 2

interface ActiveImportsState {
  imports: TrackedImport[]
  track: (jobId: number, url: string, retries?: number) => void
  /** Replace a record's job with the one a retry created, keeping the count. */
  retried: (previousJobId: number, jobId: number) => void
  setStatus: (jobId: number, status: JobStatus, errorCode?: string | null) => void
  markSavedLocally: (jobId: number) => void
  forget: (jobId: number) => void
  clearFinished: () => void
}

export const useActiveImports = create<ActiveImportsState>()(
  persist(
    (set) => ({
      imports: [],

      track: (jobId, url, retries = 0) =>
        set((state) => ({
          // Newest first, and never the same job twice — re-tracking an id that
          // is already here is what re-entering the screen would otherwise do.
          imports: [
            { jobId, url, status: null, savedLocally: false, startedAt: Date.now(), retries },
            ...state.imports.filter((entry) => entry.jobId !== jobId),
          ].slice(0, MAX_TRACKED),
        })),

      retried: (previousJobId, jobId) =>
        set((state) => {
          const existing = state.imports.find((entry) => entry.jobId === previousJobId)
          if (!existing) return state
          // The record follows the new job rather than a second row appearing:
          // one pasted link is one thing the user is waiting on, however many
          // attempts it takes underneath.
          return {
            imports: state.imports.map((entry) =>
              entry.jobId === previousJobId
                ? {
                    ...entry,
                    jobId,
                    status: null,
                    savedLocally: false,
                    retries: entry.retries + 1,
                  }
                : entry,
            ),
          }
        }),

      setStatus: (jobId, status, errorCode = null) =>
        set((state) => {
          const existing = state.imports.find((entry) => entry.jobId === jobId)
          // Returning the same array when nothing changed matters: this is
          // called from a render-driven effect on every status tick, and a fresh
          // array each time would re-render every subscriber twice a second.
          if (!existing || (existing.status === status && existing.errorCode === errorCode)) {
            return state
          }
          return {
            imports: state.imports.map((entry) =>
              entry.jobId === jobId ? { ...entry, status, errorCode } : entry,
            ),
          }
        }),

      markSavedLocally: (jobId) =>
        set((state) => {
          const existing = state.imports.find((entry) => entry.jobId === jobId)
          if (!existing || existing.savedLocally) return state
          return {
            imports: state.imports.map((entry) =>
              entry.jobId === jobId ? { ...entry, savedLocally: true } : entry,
            ),
          }
        }),

      forget: (jobId) =>
        set((state) => ({ imports: state.imports.filter((entry) => entry.jobId !== jobId) })),

      clearFinished: () =>
        set((state) => ({ imports: state.imports.filter((entry) => !isTerminal(entry.status)) })),
    }),
    {
      name: 'mio-active-imports',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
)

/**
 * The imports still doing something — what a progress panel should show.
 *
 * A `done` job whose audio has not reached the device is **still in flight**
 * (#159). The server finishing is not the end of an import when the library
 * lives on the phone: until the file is here, the song is not yours. Saying
 * otherwise would show "added" over a song that cannot be played offline.
 *
 * A `failed` job is finished either way — there is nothing to download.
 */
export function inFlight(imports: TrackedImport[]): TrackedImport[] {
  return imports.filter(
    (entry) =>
      !isTerminal(entry.status) ||
      (entry.status === 'done' && !entry.savedLocally) ||
      // A failure we are about to retry is still something the user is waiting
      // on (#222) — and the watcher has to stay mounted to do the retrying.
      willRetry(entry),
  )
}

/** Whether this device will try again on its own, without being asked. */
export function willRetry(entry: TrackedImport): boolean {
  return (
    entry.status === 'failed' && entry.retries < MAX_AUTO_RETRIES && isRetryable(entry.errorCode)
  )
}
