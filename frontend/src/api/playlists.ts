import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetch, queryString } from './client'
import type { Page, Playlist, PlaylistDetail } from './types'

export const playlistKeys = {
  all: ['playlists'] as const,
  list: () => [...playlistKeys.all, 'list'] as const,
  detail: (id: number) => [...playlistKeys.all, 'detail', id] as const,
  favourites: () => [...playlistKeys.all, 'favourites'] as const,
  favouriteIds: () => [...playlistKeys.all, 'favourite-ids'] as const,
}

export function usePlaylists() {
  return useQuery({
    queryKey: playlistKeys.list(),
    queryFn: () => apiFetch<Page<Playlist>>(`/playlists${queryString({ limit: 200 })}`),
  })
}

export function usePlaylist(id: number | null) {
  return useQuery({
    queryKey: playlistKeys.detail(id ?? -1),
    queryFn: () => apiFetch<PlaylistDetail>(`/playlists/${id}`),
    enabled: id !== null,
  })
}

export function useCreatePlaylist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<Playlist>('/playlists', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: playlistKeys.list() }),
  })
}

export function useRenamePlaylist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiFetch<Playlist>(`/playlists/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: playlistKeys.list() })
      queryClient.invalidateQueries({ queryKey: playlistKeys.detail(id) })
    },
  })
}

export function useDeletePlaylist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => apiFetch<void>(`/playlists/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: playlistKeys.list() }),
  })
}

export function useAddPlaylistItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ playlistId, songId }: { playlistId: number; songId: number }) =>
      apiFetch<PlaylistDetail>(`/playlists/${playlistId}/items`, {
        method: 'POST',
        body: JSON.stringify({ song_id: songId }),
      }),
    onSuccess: (_data, { playlistId }) => {
      queryClient.invalidateQueries({ queryKey: playlistKeys.list() })
      queryClient.invalidateQueries({ queryKey: playlistKeys.detail(playlistId) })
    },
  })
}

export function useRemovePlaylistItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ playlistId, itemId }: { playlistId: number; itemId: number }) =>
      apiFetch<void>(`/playlists/${playlistId}/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: (_data, { playlistId }) => {
      queryClient.invalidateQueries({ queryKey: playlistKeys.list() })
      queryClient.invalidateQueries({ queryKey: playlistKeys.detail(playlistId) })
    },
  })
}

export function useReorderPlaylist() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ playlistId, itemIds }: { playlistId: number; itemIds: number[] }) =>
      apiFetch<PlaylistDetail>(`/playlists/${playlistId}/items`, {
        method: 'PUT',
        body: JSON.stringify({ item_ids: itemIds }),
      }),
    // Write the server's authoritative ordering straight into the cache.
    onSuccess: (data) => queryClient.setQueryData(playlistKeys.detail(data.id), data),
  })
}

/** The favourites playlist itself, for the Favourites view. */
export function useFavourites() {
  return useQuery({
    queryKey: playlistKeys.favourites(),
    queryFn: () => apiFetch<PlaylistDetail>('/playlists/favourites'),
  })
}

/**
 * Just the hearted song ids, as a Set.
 *
 * Every list view needs to know which of its rows are hearted. Asking the
 * backend to stamp `is_favourite` on every song would mean refetching whole
 * lists on each toggle; one small cached id list is cheaper and lets the heart
 * update optimistically.
 */
export function useFavouriteIds() {
  return useQuery({
    queryKey: playlistKeys.favouriteIds(),
    queryFn: async () => {
      const body = await apiFetch<{ song_ids: number[] }>('/playlists/favourites/song-ids')
      return new Set(body.song_ids)
    },
  })
}

export function useToggleFavourite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ songId, favourite }: { songId: number; favourite: boolean }) => {
      if (favourite) {
        await apiFetch<PlaylistDetail>('/playlists/favourites/items', {
          method: 'POST',
          body: JSON.stringify({ song_id: songId }),
        })
        return
      }
      await apiFetch<void>(`/playlists/favourites/items/${songId}`, { method: 'DELETE' })
    },
    // Hearts must feel instant, so flip the cached set first and roll back if
    // the request fails.
    onMutate: async ({ songId, favourite }) => {
      await queryClient.cancelQueries({ queryKey: playlistKeys.favouriteIds() })
      const previous = queryClient.getQueryData<Set<number>>(playlistKeys.favouriteIds())
      queryClient.setQueryData<Set<number>>(playlistKeys.favouriteIds(), (current) => {
        const next = new Set(current ?? [])
        if (favourite) next.add(songId)
        else next.delete(songId)
        return next
      })
      return { previous }
    },
    onError: (_error, _variables, context: { previous?: Set<number> } | undefined) => {
      if (context?.previous) {
        queryClient.setQueryData(playlistKeys.favouriteIds(), context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: playlistKeys.favouriteIds() })
      queryClient.invalidateQueries({ queryKey: playlistKeys.favourites() })
      queryClient.invalidateQueries({ queryKey: playlistKeys.list() })
    },
  })
}
