import { useQuery } from '@tanstack/react-query'

import { allFinishedImports, type FinishedImport } from '../library/finishedImports'
import { sourcesWithAudio } from '../library/songs'

/**
 * What **this device** knows about the imports the server remembers.
 *
 * ## Why any of this exists
 *
 * The import screens were written when the server did the downloading, so they
 * read the server's answers: `imported_count` for progress, and
 * `TrackMatch.status` for which tracks landed. Both stopped meaning anything
 * when confirm began sending `download: false` (#270) — the server accepts the
 * matches and fetches nothing. The counters froze at zero and the "imported"
 * and "failed" lists were always empty however well an import went.
 *
 * The device is the only thing that knows now. These two hooks are that
 * knowledge, in the shape the screens need it.
 */

export const deviceImportKeys = {
  all: ['device-imports'] as const,
  finished: () => [...deviceImportKeys.all, 'finished'] as const,
  audio: (sourceUrls: readonly string[]) => [...deviceImportKeys.all, 'audio', sourceUrls] as const,
}

/** What every finished import did, by import id. */
export function useFinishedImports() {
  return useQuery({
    queryKey: deviceImportKeys.finished(),
    queryFn: async (): Promise<Record<string, FinishedImport>> => {
      const records = await allFinishedImports()
      return Object.fromEntries(records.map((record) => [record.importId, record]))
    },
    // One read for the whole list rather than one per row: a record is small
    // and twenty rows would otherwise be twenty AsyncStorage round-trips.
    staleTime: 0,
  })
}

/**
 * Which of these sources the device holds the audio for.
 *
 * Keyed on the URLs themselves so the answer changes when the list does — a
 * record's matches arrive a page at a time, and a cache keyed on the import id
 * would answer the first page's question forever.
 */
export function useSourcesWithAudio(sourceUrls: readonly string[]) {
  return useQuery({
    queryKey: deviceImportKeys.audio(sourceUrls),
    queryFn: () => sourcesWithAudio(sourceUrls),
    // An empty set rather than undefined while it loads: a row that does not
    // know yet should read as "not here", which is what it looked like a moment
    // ago, rather than flickering into a different list.
    placeholderData: new Set<string>(),
  })
}
