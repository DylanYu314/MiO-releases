import { useMemo } from 'react'

import { useDeviceAdds } from './deviceAdds'
import { useTrackStates, type TrackPhase } from './trackStates'

/**
 * Is this source URL being fetched *right now*, by anything (#571).
 *
 * ## Why this exists
 *
 * The library screen kept the answer in its own `useState`, set when the user
 * tapped a row **on that screen**. Everything else that fetches — an add-link, a
 * search result, a playlist import — left the row reading *"Not downloaded —
 * tap to download"* while its audio was already on the way.
 *
 * ⚠️ **Tapping it started a second, concurrent download of the same track.**
 * `downloadAudioFromUrl` appends 2 MiB chunks to one path, so two writers
 * interleaving produce a file of plausible length that does not play. I
 * feared *"any error"*; the real risk was silent corruption.
 *
 * That is the *a control derived from a data structure is right only while the
 * two coincide* lesson, again: the screen derived the answer from its own state
 * rather than from the fact.
 *
 * ## Why it reads two stores and not one
 *
 * Because there are two import loops, and this project has already shipped one
 * bug from remembering only one of them (#555):
 *
 * | store | who writes it |
 * |---|---|
 * | `useDeviceAdds` | everything through `importToDevice` — add-link, search, `useDownloadSong` |
 * | `useTrackStates` | `playlistImport.ts`, which runs its own loop and never touches the other |
 *
 * A third loop would have to be added here too. That is a real cost, and it is
 * smaller than the alternative — the two stores exist because the two paths
 * genuinely differ, and merging them is a much larger change than this bug
 * justifies.
 *
 * Pure and exported so a test can hand it every combination without rendering.
 */

/** The phases of a review-based import that mean work is in flight. */
const BUSY_PHASES: readonly TrackPhase[] = ['waiting', 'extracting', 'downloading', 'saving']

export function isFetching(
  sourceUrl: string,
  adds: readonly { url: string; status: string }[],
  runs: Record<number, Record<string, { phase: TrackPhase }>>,
): boolean {
  if (adds.some((add) => add.url === sourceUrl && add.status === 'working')) return true
  return Object.values(runs).some((tracks) => {
    const state = tracks[sourceUrl]
    return state !== undefined && BUSY_PHASES.includes(state.phase)
  })
}

/**
 * The set of URLs being fetched right now.
 *
 * A set rather than a per-row hook: the library is a `FlatList` of hundreds of
 * rows, and a hook per row would subscribe every one of them to two stores.
 * One subscription in the screen, one `Set.has` per row.
 */
export function useFetchingUrls(): Set<string> {
  const adds = useDeviceAdds((state) => state.adds)
  const runs = useTrackStates((state) => state.runs)

  // Memoized on the two slices so the identity is stable across every other
  // re-render of a screen that draws hundreds of rows.
  return useMemo(() => {
    const urls = new Set<string>()
    for (const add of adds) if (add.status === 'working') urls.add(add.url)
    for (const tracks of Object.values(runs)) {
      for (const [url, state] of Object.entries(tracks)) {
        if (BUSY_PHASES.includes(state.phase)) urls.add(url)
      }
    }
    return urls
  }, [adds, runs])
}
