import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiFetch, queryString } from './client'
import type { Page, SpotifyPlaylist, SpotifyStatus } from './types'

/** The picker's page size — Spotify caps this endpoint at 50 per page. */
const PLAYLISTS_PAGE_LIMIT = 20

export const spotifyKeys = {
  all: ['spotify'] as const,
  status: () => [...spotifyKeys.all, 'status'] as const,
  playlists: (accountId: number | null, offset: number) =>
    [...spotifyKeys.all, 'playlists', accountId, offset] as const,
}

export function useSpotifyStatus() {
  return useQuery({
    queryKey: spotifyKeys.status(),
    queryFn: () => apiFetch<SpotifyStatus>('/spotify/status'),
  })
}

// There is deliberately no "useConnectSpotify" mutation: connecting is a full
// page navigation to /api/spotify/login (the backend redirects the browser to
// Spotify's consent page, which fetch could not follow cross-origin).

export function useSpotifyPlaylists(accountId: number | null, offset: number) {
  return useQuery({
    queryKey: spotifyKeys.playlists(accountId, offset),
    queryFn: () =>
      apiFetch<Page<SpotifyPlaylist>>(
        `/spotify/playlists${queryString({
          account_id: accountId ?? undefined,
          limit: PLAYLISTS_PAGE_LIMIT,
          offset,
        })}`,
      ),
    enabled: accountId !== null,
    placeholderData: (previous) => previous,
  })
}

export function useDisconnectSpotify() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (accountId: number) =>
      apiFetch<void>(`/spotify/accounts/${accountId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spotifyKeys.status() }),
  })
}
