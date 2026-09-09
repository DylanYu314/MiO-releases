import { create } from 'zustand'

import type { ListImportProgress } from '../library/listImport'

/**
 * How far a device import has got, published for any screen (#106, #492).
 *
 * The same split `useImportProgress` makes, for the same reason its docblock
 * gives: the run is module state that outlives the screen, so a callback owned
 * by one mount cannot reach a second mount that arrived half way through. One
 * writer, many readers, and the readers come and go.
 *
 * ## One store for every source, unlike `useImportProgress`
 *
 * This was `useGoogleImportProgress` and it is shared as of #492, because
 * `runListImport` publishes exactly one shape whatever produced the list. Two
 * identical stores is the drift risk that made the import *loop* worth
 * extracting, at a twentieth of the size and with none of the excuse.
 *
 * ⚠️ **Still kept separate from `useImportProgress`**, which is the *server*
 * import's. That one is keyed by a numeric server import id and its value
 * carries a matched track's title and attempt; this one is keyed by a string
 * and there are no matches, no attempts to review and no server-side run at
 * all. Widening the key to `string | number` would put two unrelated features
 * in one map and make every reader ask which kind it had.
 *
 * ## Keys
 *
 * Whatever the run's `ListImportSpec.key` is. Google uses its bare playlist id
 * (`PL…`), Bilibili namespaces its numeric `media_id` as `bilibili:<id>` — so
 * the two cannot collide even in principle.
 */
interface ListImportProgressStore {
  runs: Record<string, ListImportProgress>
  report: (key: string, progress: ListImportProgress) => void
  forget: (key: string) => void
}

export const useListImportProgress = create<ListImportProgressStore>((set) => ({
  runs: {},
  report: (key, progress) => set((state) => ({ runs: { ...state.runs, [key]: progress } })),
  forget: (key) =>
    set((state) => {
      const { [key]: _gone, ...rest } = state.runs
      return { runs: rest }
    }),
}))

/** Test seam: module state outlives the test that wrote to it. */
export function resetListImportProgress(): void {
  useListImportProgress.setState({ runs: {} })
}
