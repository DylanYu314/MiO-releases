import { create } from 'zustand'

import type { PlaylistImportProgress } from '../library/playlistImport'

/**
 * How far a device-side playlist import has got, published for any screen.
 *
 * ## Why a store rather than the callback it had
 *
 * `importPlaylistOnDevice` took an `onProgress` callback, and the run is
 * **module state that outlives the screen** — deliberately, so leaving the page
 * does not stop the download. Those two facts do not fit together: the callback
 * belongs to whichever mount started the run, and a second mount is turned away
 * at the door (`inProgress.has(importId)` returns null) with its own callback
 * never wired to anything.
 *
 * So re-entering the page during a run showed **0 of 13, frozen** — the screen
 * had no progress of its own and no way to hear about the run's. Reported as
 * "sometimes it's not even showing at all".
 *
 * This is the same split `usePlaybackStatus` makes for the player, for the same
 * reason: one writer, many readers, and the readers come and go.
 */
interface ImportProgressStore {
  /** Keyed by import id: several can be in flight, and the queue screen and the
   *  import page may be watching different ones. */
  runs: Record<string, PlaylistImportProgress>
  report: (importId: string, progress: PlaylistImportProgress) => void
  forget: (importId: string) => void
}

export const useImportProgress = create<ImportProgressStore>((set) => ({
  runs: {},
  report: (importId, progress) =>
    set((state) => ({ runs: { ...state.runs, [importId]: progress } })),
  forget: (importId) =>
    set((state) => {
      const { [importId]: _gone, ...rest } = state.runs
      return { runs: rest }
    }),
}))

/** Test seam: module state outlives the test that wrote to it. */
export function resetImportProgress(): void {
  useImportProgress.setState({ runs: {} })
}
