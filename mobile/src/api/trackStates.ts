import { create } from 'zustand'

import type { FailureKind } from '../library/failureKind'

/**
 * Where every track of a playlist import has got to (#452).
 *
 * ## Why per track, when there is already a progress bar
 *
 * The bar says "45 of 135" and the line under it names the one track in hand.
 * That is enough to tell a working import from a stopped one and nothing else.
 * I asked for the other view:
 *
 * > *"show the downloading progress for each individual track, fetched →
 * > waiting → downloading → success or failed … if the track is failed, display
 * > the type, and allow retry"*
 *
 * Two downloads run at once (`CONCURRENCY = 2`), so at any moment most of a
 * 135-track import is `waiting` and the interesting question — *which* tracks
 * failed and why — has until now only been answerable by reading Diagnostics.
 *
 * ## Why a store rather than the result object
 *
 * The same reason `useImportProgress` is one: the run is module state that
 * **outlives the screen**, deliberately, so leaving the page does not stop the
 * download. A screen that mounts half way through has to be able to ask.
 *
 * This holds the *live* view. `finishedImports` persists the outcome, because a
 * store dies with the JS context and "which four tracks failed" is exactly the
 * question somebody asks after coming back to the app.
 */

/** What one track is doing, or what became of it. */
export type TrackPhase =
  | 'waiting'
  | 'extracting'
  | 'downloading'
  | 'saving'
  | 'done'
  | 'failed'
  /** Already on the device when the run started — no work, and not a failure. */
  | 'carried'

export interface TrackState {
  phase: TrackPhase
  /** Which attempt is in hand, 1-based. Only interesting above 1. */
  attempt: number
  /** Why it failed, when it did. Null for every other phase. */
  failure: FailureKind | null
  /**
   * How it failed, in the thrower's own words — `Download refused with status
   * 403 at byte 0` (#582).
   *
   * Optional, and it is the second half of the pair rather than a replacement:
   * `failure` says whether to try again, which is what the user wants, and this
   * says *what happened*, which is the only thing that separates a block from a
   * spent URL from a timeout. A playlist import used to carry the first and
   * discard the second, so eighteen failed tracks all read the same.
   *
   * `undefined` on states written before #582 and on every non-failed phase.
   */
  detail?: string | null
}

interface TrackStatesStore {
  /** `importId → source URL → state`. Keyed by URL because that is what both
   *  the import loop and the review rows have; positions shift, URLs do not. */
  runs: Record<string, Record<string, TrackState>>
  set: (importId: string, url: string, state: TrackState) => void
  /** Everything known about one import's tracks, or an empty map. */
  forImport: (importId: string) => Record<string, TrackState>
  /** Start a run over: a retry is the truth about that import now. */
  reset: (importId: string) => void
  forget: (importId: string) => void
}

export const useTrackStates = create<TrackStatesStore>((set, get) => ({
  runs: {},
  set: (importId, url, state) =>
    set((current) => ({
      runs: {
        ...current.runs,
        [importId]: { ...(current.runs[importId] ?? {}), [url]: state },
      },
    })),
  forImport: (importId) => get().runs[importId] ?? {},
  reset: (importId) => set((current) => ({ runs: { ...current.runs, [importId]: {} } })),
  forget: (importId) =>
    set((current) => {
      const { [importId]: _gone, ...rest } = current.runs
      return { runs: rest }
    }),
}))

/** Test seam: module state outlives the test that wrote to it. */
export function resetTrackStates(): void {
  useTrackStates.setState({ runs: {} })
}

/**
 * The failures worth persisting, as `finishedImports` stores them.
 *
 * Only the failures: a `done` track is already answered by the library holding
 * its audio, and writing 135 entries to AsyncStorage to record that 131 of them
 * worked is a cost with no reader.
 */
export function failuresIn(states: Record<string, TrackState>): Record<string, FailureKind> {
  const failures: Record<string, FailureKind> = {}
  for (const [url, state] of Object.entries(states)) {
    if (state.phase === 'failed' && state.failure) failures[url] = state.failure
  }
  return failures
}
