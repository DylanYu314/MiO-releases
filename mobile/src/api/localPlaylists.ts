import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  addSongsToPlaylist,
  createPlaylist,
  deletePlaylist,
  deletePlaylists,
  favouriteSongIds,
  playlistIdsForSong,
  listPlaylistItems,
  listPlaylists,
  removePlaylistItems,
  renamePlaylist,
  reorderPlaylist,
  setFavourite,
} from '../library/playlists'
import { localLibraryKeys } from './localLibrary'

/**
 * Playlists and favourites, read from and written to this device (#219).
 *
 * The server hooks these replace lived in `api/playlists.ts`, unused, until
 * #324 deleted that module outright. This is the only playlist client now.
 *
 * ## One key, invalidated together
 *
 * Playlists, their contents and the favourite ids are three reads of one table
 * pair, and every write touches more than one of them: hearting a song changes
 * the favourite ids *and* the favourites playlist's count. Rather than track
 * which, every mutation invalidates the shared prefix.
 *
 * That is cheap because these are local reads — the thing that made
 * fine-grained invalidation worth it on the server was the round trip, and
 * there isn't one. It also let the old server client's optimistic-cache trick
 * for the favourite ids go, since it existed to hide latency that no longer
 * exists — that client has since been deleted outright (#324).
 */

export const playlistKeys = {
  all: ['local-playlists'] as const,
  list: () => [...playlistKeys.all, 'list'] as const,
  detail: (id: string | null) => [...playlistKeys.all, 'detail', id] as const,
  favouriteIds: () => [...playlistKeys.all, 'favourite-ids'] as const,
  forSong: (songId: string | null) => [...playlistKeys.all, 'for-song', songId] as const,
}

export function useLocalPlaylists() {
  return useQuery({ queryKey: playlistKeys.list(), queryFn: listPlaylists })
}

export function useLocalPlaylist(playlistId: string | null) {
  return useQuery({
    queryKey: playlistKeys.detail(playlistId),
    queryFn: () => listPlaylistItems(playlistId as string),
    enabled: playlistId !== null,
  })
}

/** The hearted song ids, as a Set — what a row needs to draw its heart. */
export function useLocalFavouriteIds() {
  return useQuery({
    queryKey: playlistKeys.favouriteIds(),
    queryFn: async () => new Set(await favouriteSongIds()),
  })
}

/** Which playlists a song is already in, as a Set (#231). */
export function useLocalPlaylistIdsForSong(songId: string | null) {
  return useQuery({
    queryKey: playlistKeys.forSong(songId),
    queryFn: async () => new Set(await playlistIdsForSong(songId as string)),
    enabled: songId !== null,
  })
}

/** Every write invalidates both the playlists and the library: a playlist's
 *  item count is part of what the library screen shows. */
function useInvalidateAfterWrite() {
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: playlistKeys.all })
    await queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
  }
}

export function useCreateLocalPlaylist() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({ mutationFn: (name: string) => createPlaylist(name), onSuccess: invalidate })
}

export function useRenameLocalPlaylist() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({
    mutationFn: ({ playlistId, name }: { playlistId: string; name: string }) =>
      renamePlaylist(playlistId, name),
    onSuccess: invalidate,
  })
}

export function useDeleteLocalPlaylist() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({
    mutationFn: (playlistId: string) => deletePlaylist(playlistId),
    onSuccess: invalidate,
  })
}

/**
 * Delete several playlists at once (#570).
 *
 * One mutation and one invalidation, for the reason #569 established on the
 * library: looping the single-playlist hook refreshes the list between every
 * row, which is the part the user actually watches happen.
 */
export function useDeleteLocalPlaylists() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({
    mutationFn: (playlistIds: readonly string[]) => deletePlaylists(playlistIds),
    onSuccess: invalidate,
  })
}

export function useAddToLocalPlaylist() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({
    mutationFn: ({ playlistId, songIds }: { playlistId: string; songIds: string[] }) =>
      addSongsToPlaylist(playlistId, songIds),
    onSuccess: invalidate,
  })
}

export function useRemoveFromLocalPlaylist() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({
    mutationFn: ({ playlistId, itemIds }: { playlistId: string; itemIds: string[] }) =>
      removePlaylistItems(playlistId, itemIds),
    onSuccess: invalidate,
  })
}

export function useReorderLocalPlaylist() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({
    mutationFn: ({ playlistId, itemIds }: { playlistId: string; itemIds: string[] }) =>
      reorderPlaylist(playlistId, itemIds),
    onSuccess: invalidate,
  })
}

export function useSetLocalFavourite() {
  const invalidate = useInvalidateAfterWrite()
  return useMutation({
    mutationFn: ({ songId, favourite }: { songId: string; favourite: boolean }) =>
      setFavourite(songId, favourite),
    onSuccess: invalidate,
  })
}
