import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { listLocalSongs, type LocalSong } from '../library/songs'

/**
 * The library, read from this device (#216).
 *
 * > Music is stored on the user's device. The server is not where their music
 * > lives.
 *
 * Until now that was true of the *audio* and not of the list: the library
 * screen asked `GET /songs`, so a song the device fetched itself was invisible
 * — downloaded, playable, and nowhere on screen. That is exactly what I hit
 * the first time a device import succeeded.
 *
 * ## The clean start becomes visible here
 *
 * I decided (2026-07-30) that nothing migrates down from the server: the
 * device library begins empty and fills as things are imported. So switching
 * this read is the moment the songs on `mio.dlany.uk` stop appearing on the
 * phone. **Intended, and it will look like data loss the first time.**
 *
 * It was deliberately not done before the import handover (#212, #215) and the
 * device-side import (#246), because switching first would have shown an empty
 * library that could never fill.
 *
 * ## Why TanStack Query for a local read
 *
 * Not for caching — SQLite is already fast. For **invalidation**: an import
 * finishing needs the list to refresh, and the rest of the app already speaks
 * that language. One `invalidateQueries` and the library updates, from any
 * screen, without a bespoke subscription.
 */

export const localLibraryKeys = {
  all: ['local-library'] as const,
  songs: () => [...localLibraryKeys.all, 'songs'] as const,
}

export type LibrarySort = 'added_at' | 'title' | 'artist'

export interface LocalLibraryQuery {
  q?: string
  sort?: LibrarySort
}

/** Filter and order in memory.
 *
 *  A phone's library is hundreds of rows, not millions, and doing it here keeps
 *  one cached read serving every sort and search — no round trip to SQLite for
 *  a keystroke. Push it into SQL when someone has a library that needs it. */
export function selectSongs(songs: LocalSong[], query: LocalLibraryQuery): LocalSong[] {
  const needle = query.q?.trim().toLowerCase()
  const filtered = needle
    ? songs.filter(
        (song) =>
          song.title.toLowerCase().includes(needle) || song.artist.toLowerCase().includes(needle),
      )
    : songs

  const sort = query.sort ?? 'added_at'
  return [...filtered].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title)
    if (sort === 'artist') return a.artist.localeCompare(b.artist)
    // Newest first, matching what the server list did.
    return b.added_at.localeCompare(a.added_at)
  })
}

/**
 * Which sources the library already holds the audio for.
 *
 * `file_uri` is the whole test, the same one `sourcesWithAudio` applies in SQL
 * and the same one `isPlayable` means: a row whose download never finished is
 * not a song you have.
 */
export function sourcesWithAudioIn(songs: readonly LocalSong[]): Set<string> {
  return new Set(songs.filter((song) => song.file_uri).map((song) => song.source_url))
}

/**
 * "Added" that survives leaving the screen, the app, and the phone (#376).
 *
 * *"when we added a song, then research it, the second time it might
 * still display as added, but how do we make it permanent"* — "might" because
 * the answer lived in a search result row's `useState`, so it lasted exactly as
 * long as that row.
 *
 * **Deliberately not a cache of what has been added.** A remembered flag goes
 * stale the moment a track is deleted, and would then lie in the direction that
 * matters most — offering nothing where the library has nothing. The device
 * library is the truth, `source_url` is UNIQUE since schema v6, so the question
 * is exact.
 *
 * Built on `useLocalSongs`' cached read rather than its own query, which is what
 * makes it correct without any new invalidation: every path that adds a song
 * already invalidates `localLibraryKeys.all`, and a second key would have to be
 * remembered by each of them.
 */
export function useLibrarySources(): Set<string> {
  const { data } = useQuery({
    queryKey: localLibraryKeys.songs(),
    queryFn: listLocalSongs,
    staleTime: Infinity,
  })
  return useMemo(() => sourcesWithAudioIn(data ?? []), [data])
}

export function useLocalSongs(query: LocalLibraryQuery = {}) {
  const result = useQuery({
    queryKey: localLibraryKeys.songs(),
    queryFn: listLocalSongs,
    // The device's own database: nothing else can change it behind our back,
    // so a refetch on focus would be work for no possible new information.
    staleTime: Infinity,
  })

  return { ...result, songs: result.data ? selectSongs(result.data, query) : [] }
}
