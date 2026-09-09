import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { ExternalPlaylist } from '../library/externalPlaylist'
import {
  addTracks,
  chooseMatch,
  createImport,
  deleteImport,
  getImport,
  importableCount,
  listImports,
  listMatches,
  setMatchCandidates,
  pageMatches,
  retryFailedMatches,
  setMatchStatus,
  setMatchStatuses,
  updateImport,
  type ImportService,
  type LocalPlaylistImport,
  type LocalTrackMatchStatus,
} from '../library/playlistImports'
import { fetchPlaylistTracks } from '../library/spotifyApi'
import { fetchYouTubePlaylist } from '../library/youtubePlaylist'

/**
 * Playlist imports, read from the device (#611).
 *
 * ## What changed, and what deliberately did not
 *
 * Every hook here keeps its **name, query key and return shape**; only the
 * `queryFn`/`mutationFn` moved from `apiFetch` to SQLite. That is the precedent
 * #353 set in `api/search.ts` — *"a different `queryFn` behind the same key"* —
 * and it is why `MatchReview.tsx` needed no logic change. A diff there would
 * have meant this port drifted rather than moved.
 *
 * ⚠️ **The WebSocket is gone.** It existed to hear about work happening on the
 * server; the work happens here now, so a mutation invalidating its own key is
 * the whole of it. `FALLBACK_POLL_INTERVAL_MS` and `importSocketUrl` went with
 * it.
 *
 * ## ✅ Every source is local now
 *
 * NetEase, QQ and Kugou fetch their own track lists (ADR-013); YouTube
 * playlists list on the device (#622); Spotify signs in and reads its API from
 * here (#612). `serverTracklist.ts` existed to bridge the last two and is
 * deleted.
 *
 * **No import path reaches a server.** The only thing left that does is
 * `POST /jobs` for sites neither device extractor can read, which is
 * self-host-only by decision (#614).
 */

/** Ids are TEXT on the device (#610), minted by `randomHex`. */
export type ImportId = string

/**
 * `list` and `detail` are *siblings* under `all`, never nested one inside the
 * other. TanStack invalidates by key prefix, so a flat
 * `['playlist-imports']` / `['playlist-imports', id]` pair means invalidating the
 * list silently invalidates every detail too — and confirming an import would
 * refetch it and snap the screen back from "Downloading" to "Ready for review".
 * A test caught exactly that.
 */
export const importKeys = {
  all: ['playlist-imports'] as const,
  list: () => [...importKeys.all, 'list'] as const,
  detail: (importId: ImportId | null) => [...importKeys.all, 'detail', importId] as const,
  /** Every page of every filter for one import, so a single accept can
   *  invalidate the lot — the counts move with it. */
  matchesRoot: (importId: ImportId) => [...importKeys.all, 'matches', importId] as const,
  matches: (importId: ImportId, status: MatchStatusFilter) =>
    [...importKeys.matchesRoot(importId), status] as const,
}

/** The filter tabs above the review list. `all` means "no status filter". */
export type MatchStatusFilter = LocalTrackMatchStatus | 'all'

const PAGE_SIZE = 20
const MATCHES_PAGE_SIZE = 50

/**
 * Start importing a Spotify playlist (#203).
 *
 * ✅ **Fetched on the device since #612**, so this reaches no server at all —
 * and with it the last one goes. `serverTracklist.ts` is deleted.
 *
 * ⚠️ **It still keeps the review step**, unlike a YouTube playlist. A Spotify
 * track is *not* a YouTube video: every entry is a title and an artist that
 * still has to be found, so each row lands `pending` and `deviceMatching.ts`
 * searches and scores it (ADR-013, ADR-014). The import goes to `matching`,
 * which is what makes the review screen start searching on arrival.
 */
export function useCreateSpotifyImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { playlistId: string; name: string }) => {
      const tracks = await fetchPlaylistTracks(input.playlistId)
      const id = await createImport({
        service: 'spotify',
        externalPlaylistId: input.playlistId,
        name: input.name,
        trackCount: tracks.length,
      })
      await addTracks(
        id,
        tracks.map((track) => ({
          external_id: track.externalId,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration_s: track.durationSeconds,
        })),
      )
      await updateImport(id, { status: 'matching' })
      return { id }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.list() }),
  })
}

/**
 * Start importing a public or unlisted YouTube playlist (ADR-010).
 *
 * ✅ **Listed on the device since #622**, so this reaches no server at all.
 *
 * ⚠️ **No matching phase, and that is the decision** (ADR-014, I:
 * *"its from youtube, user know what they importing"*). A playlist hands back
 * exact video ids, so each entry **is its own candidate** — searching YouTube
 * for a video whose id you already have would be absurd. Every row therefore
 * arrives `auto_matched` with its URL already chosen, and the import lands at
 * `review` only so the user still confirms before anything downloads.
 */
export function useCreateYouTubeImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (url: string) => {
      const listing = await fetchYouTubePlaylist(url)
      const id = await createImport({
        service: 'youtube',
        externalPlaylistId: listing.playlistId,
        name: listing.name,
        trackCount: listing.tracks.length,
      })
      await addTracks(
        id,
        listing.tracks.map((track) => ({
          external_id: track.videoId,
          title: track.title,
          artist: track.uploader ?? '',
          duration_s: track.durationSeconds,
        })),
      )
      const rows = await listMatches(id)
      for (const [index, row] of rows.entries()) {
        const track = listing.tracks[index]
        if (!track) continue
        await setMatchCandidates(
          row.id,
          [
            {
              url: `https://www.youtube.com/watch?v=${track.videoId}`,
              title: track.title,
              uploader: track.uploader,
              duration: track.durationSeconds,
              // The listing carries it since #635. Without this the review row
              // drew an empty square, while a Spotify import against the same
              // source had art — its candidates come from search, which has
              // always read one.
              thumbnail: track.thumbnail,
              // ⚠️ `null`, not 1. `confidence` means *machine* confidence, and
              // nothing scored this — the entry is the answer, not a guess
              // about it. A number here would be a measurement nobody made.
              score: null,
              source: 'youtube',
            },
          ],
          'auto_matched',
        )
      }
      await updateImport(id, { status: 'review', matched_count: rows.length })
      return { id }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.list() }),
  })
}

/**
 * Start an import from a track list this device fetched itself (ADR-013).
 *
 * NetEase (#102), QQ Music (#103) and Kugou (#104) — and since #611 this
 * **touches no server at all**. It lands at `matching`, which is what makes the
 * review screen start searching on arrival with no extra wiring.
 */
export function useCreateExternalImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (playlist: ExternalPlaylist) => {
      const id = await createImport({
        // `ExternalPlaylist.service` is free-form by design (ADR-013): a fetcher
        // names its own service and the server never validated it either. The
        // three that exist are all `ImportService` members.
        service: playlist.service as ImportService,
        externalPlaylistId: playlist.sourceUrl,
        name: playlist.name,
        trackCount: playlist.tracks.length,
      })
      await addTracks(
        id,
        playlist.tracks.map((track) => ({
          external_id: track.externalId,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration_s: track.durationSeconds,
        })),
      )
      await updateImport(id, { status: 'matching' })
      return { id }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.list() }),
  })
}

/**
 * One filter's worth of matches, paged (#203).
 *
 * Infinite rather than offset-paged like the web's table: a phone scrolls, it
 * does not page. The filter is part of the key, so switching tabs is a
 * different list rather than a refetch of the same one.
 *
 * Still paged even though SQLite could return the lot, because two hundred rows
 * through the bridge at once is the thing the paging was for — and because
 * changing it would mean changing the screen.
 */
export function useImportMatches(importId: ImportId | null, status: MatchStatusFilter) {
  return useInfiniteQuery({
    queryKey: importKeys.matches(importId as ImportId, status),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      pageMatches(importId as ImportId, status, MATCHES_PAGE_SIZE, pageParam),
    getNextPageParam: (lastPage) => {
      const loaded = lastPage.offset + lastPage.items.length
      return loaded < lastPage.total ? loaded : undefined
    },
    enabled: importId !== null,
  })
}

/**
 * Accept, reject, or repoint one track.
 *
 * ⚠️ `chosenUrl` without a status is a **repoint**, and `chooseMatch` derives
 * `confidence` from the stored candidates rather than being told it — so a
 * hand-pasted URL scores `null` instead of inheriting the score of whatever it
 * replaced. That rule used to live on the server (#610).
 */
export function useUpdateMatch(importId: ImportId) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      matchId: string
      status?: 'accepted' | 'rejected'
      chosenUrl?: string
    }) => {
      if (input.chosenUrl !== undefined) await chooseMatch(input.matchId, input.chosenUrl)
      else if (input.status !== undefined) await setMatchStatus(input.matchId, input.status)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.matchesRoot(importId) }),
  })
}

/** Accept or reject several at once — the only way a hundred-track playlist is
 *  reviewable on a phone at all. */
export function useBulkUpdateMatches(importId: ImportId) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { matchIds: string[]; status: 'accepted' | 'rejected' }) =>
      setMatchStatuses(input.matchIds, input.status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.matchesRoot(importId) }),
  })
}

/**
 * How many tracks confirming would actually download.
 *
 * Two statuses are importable: `auto_matched` (the matcher was confident and
 * the user left it alone) and `accepted` (the user said yes). Worth having on
 * the button — "Import 43 tracks" and "Import 0 tracks" are very different
 * things to be about to tap.
 */
export function useImportableCount(importId: ImportId | null) {
  return useQuery({
    queryKey: [...importKeys.matchesRoot(importId as ImportId), 'importable-count'] as const,
    queryFn: () => importableCount(importId as ImportId),
    enabled: importId !== null,
  })
}

/**
 * Recent imports.
 *
 * Kept as an infinite query although the local list is small and unpaged: the
 * screen consumes pages, and the point of this change is that the screen does
 * not change.
 */
export function usePlaylistImports() {
  return useInfiniteQuery({
    queryKey: importKeys.list(),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const all = await listImports()
      const items = all.slice(pageParam, pageParam + PAGE_SIZE)
      return { items, total: all.length, limit: PAGE_SIZE, offset: pageParam }
    },
    getNextPageParam: (lastPage) => {
      const loaded = lastPage.offset + lastPage.items.length
      return loaded < lastPage.total ? loaded : undefined
    },
  })
}

export function usePlaylistImport(importId: ImportId | null) {
  return useQuery({
    queryKey: importKeys.detail(importId),
    queryFn: () => getImport(importId as ImportId),
    enabled: importId !== null,
  })
}

/**
 * Start the download phase.
 *
 * Nothing downloads until a human asks: an import stops at `review`, and this
 * is the only way past it. It writes `importing` before anything else happens,
 * so a double-tap finds a run already started rather than starting a second —
 * which is what the server's synchronous flip and its 409 guard were for.
 */
export function useConfirmImport(importId: ImportId) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const current = await getImport(importId)
      if (current?.status === 'importing') return current
      const total = await importableCount(importId)
      await updateImport(importId, { status: 'importing', import_total: total, imported_count: 0 })
      return getImport(importId)
    },
    onSuccess: (updated) => {
      if (updated) queryClient.setQueryData(importKeys.detail(importId), updated)
      queryClient.invalidateQueries({ queryKey: importKeys.list() })
    },
  })
}

/**
 * Forget an import record (#224).
 *
 * This deletes the **record**, not the music. The songs it produced, and the
 * playlist, are ordinary library rows and stay. Worth being sure of, because
 * "delete" next to a list of imports could easily read the other way.
 */
export function useDeletePlaylistImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (importId: ImportId) => deleteImport(importId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.list() }),
  })
}

/**
 * Try the tracks that failed, again (#223).
 *
 * Only the tracks recorded as failed — the successful ones keep their songs, so
 * this is not a second import of the whole playlist. Not automatic, unlike a
 * single link (#222): a playlist import is long and already paces itself.
 */
export function useRetryFailedTracks(importId: ImportId) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<LocalPlaylistImport | null> => {
      await retryFailedMatches(importId)
      return getImport(importId)
    },
    onSuccess: (updated) => {
      if (updated) queryClient.setQueryData(importKeys.detail(importId), updated)
      queryClient.invalidateQueries({ queryKey: importKeys.list() })
      queryClient.invalidateQueries({ queryKey: importKeys.matchesRoot(importId) })
    },
  })
}
