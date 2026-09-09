import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { usePlayerStore } from '../player/store'
import { apiFetch, queryString } from './client'
import { playlistKeys } from './playlists'
import type { Page, Song, SongQuery } from './types'

export const songKeys = {
  all: ['songs'] as const,
  list: (query: SongQuery) => [...songKeys.all, 'list', query] as const,
}

export function useSongs(query: SongQuery) {
  return useQuery({
    queryKey: songKeys.list(query),
    queryFn: () => apiFetch<Page<Song>>(`/songs${queryString({ ...query })}`),
    // Keeps the previous page visible while the next one loads, instead of
    // flashing a spinner on every keystroke or page change.
    placeholderData: (previous) => previous,
  })
}

export function useDeleteSong() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (songId: number) => apiFetch<void>(`/songs/${songId}`, { method: 'DELETE' }),
    onSuccess: (_data, songId) => {
      // Keep the persisted player queue in step — a deleted song should not
      // linger and 404 on the next reload.
      usePlayerStore.getState().removeSongById(songId)
      queryClient.invalidateQueries({ queryKey: songKeys.all })
      // Deleting a song cascades to its playlist entries on the backend, so any
      // playlist showing it is now stale — including the one being viewed, now
      // that a song can be deleted from inside a playlist.
      queryClient.invalidateQueries({ queryKey: playlistKeys.all })
    },
  })
}

export function songAudioUrl(songId: number): string {
  return `/api/songs/${songId}/audio`
}

export function songCoverUrl(songId: number): string {
  return `/api/songs/${songId}/cover`
}
