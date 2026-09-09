import { getInstallId } from './installId'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiFetch, queryString } from './client'
import { isImportTerminal, type Page, type PlaylistImport, type TrackMatch } from './types'

/** Fallback poll interval, used only if the WebSocket can't be established. */
const FALLBACK_POLL_INTERVAL_MS = 1000

export const MATCHES_PAGE_LIMIT = 50

export type MatchStatusFilter = TrackMatch['status'] | 'all'

export const importKeys = {
  all: ['playlist-imports'] as const,
  list: () => [...importKeys.all, 'list'] as const,
  detail: (importId: number | null) => [...importKeys.all, 'detail', importId] as const,
  matchesRoot: (importId: number) => [...importKeys.all, 'matches', importId] as const,
  matches: (importId: number, status: MatchStatusFilter, offset: number) =>
    [...importKeys.matchesRoot(importId), status, offset] as const,
}

export function useCreatePlaylistImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { accountId: number; playlistId: string; name: string }) =>
      apiFetch<PlaylistImport>('/playlist-imports', {
        method: 'POST',
        body: JSON.stringify({
          account_id: input.accountId,
          playlist_id: input.playlistId,
          name: input.name,
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.list() }),
  })
}

export function useCreateYouTubeImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (url: string) =>
      apiFetch<PlaylistImport>('/playlist-imports/youtube', {
        method: 'POST',
        body: JSON.stringify({ url }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.list() }),
  })
}

export function usePlaylistImports() {
  return useQuery({
    queryKey: importKeys.list(),
    queryFn: () => apiFetch<Page<PlaylistImport>>(`/playlist-imports${queryString({ limit: 20 })}`),
    // Poll while any import is still running so the "In progress" section on the
    // import page shows live progress; stop once everything is terminal.
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? []
      return items.some((item) => !isImportTerminal(item.status)) ? 2000 : false
    },
  })
}

export function useImportMatches(importId: number, status: MatchStatusFilter, offset: number) {
  return useQuery({
    queryKey: importKeys.matches(importId, status, offset),
    queryFn: () =>
      apiFetch<Page<TrackMatch>>(
        `/playlist-imports/${importId}/matches${queryString({
          status: status === 'all' ? undefined : status,
          limit: MATCHES_PAGE_LIMIT,
          offset,
        })}`,
      ),
    placeholderData: (previous) => previous,
  })
}

function importSocketUrl(importId: number): string {
  // Same host as the page, so the Vite dev proxy (and any future reverse
  // proxy) handles it; ws:// on http pages, wss:// on https.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/playlist-imports/${importId}/ws?install=${encodeURIComponent(getInstallId() ?? '')}`
}

/**
 * Subscribe to an import's progress over a WebSocket, writing each update
 * straight into the query cache — an adaptation of useJobSocket in jobs.ts.
 *
 * Returns whether the socket failed, so the caller can fall back to polling.
 */
function usePlaylistImportSocket(importId: number | null): { failed: boolean } {
  const queryClient = useQueryClient()
  // Records *which* import the socket failed for, rather than a bare boolean
  // that would need resetting in an effect (see useJobSocket for the why).
  const [failedImportId, setFailedImportId] = useState<number | null>(null)
  const failed = importId !== null && failedImportId === importId
  const receivedRef = useRef(false)

  useEffect(() => {
    if (importId === null) return
    receivedRef.current = false

    const socket = new WebSocket(importSocketUrl(importId))

    socket.onmessage = (event) => {
      try {
        const incoming = JSON.parse(event.data) as PlaylistImport
        receivedRef.current = true
        const previous = queryClient.getQueryData<PlaylistImport>(importKeys.detail(importId))
        queryClient.setQueryData(importKeys.detail(importId), incoming)
        // Match rows change underneath on a status flip (matching -> review
        // fills them in) and on every completed download while importing —
        // refetch any visible page so row statuses stay live.
        const rowsChanged =
          previous &&
          (previous.status !== incoming.status ||
            previous.imported_count !== incoming.imported_count ||
            previous.failed_count !== incoming.failed_count)
        if (rowsChanged) {
          queryClient.invalidateQueries({ queryKey: importKeys.matchesRoot(importId) })
        }
      } catch {
        // Ignore anything that isn't an import payload.
      }
    }

    socket.onerror = () => setFailedImportId(importId)

    socket.onclose = (event) => {
      // A clean close after the import finishes is not a failure.
      if (!event.wasClean && !receivedRef.current) setFailedImportId(importId)
    }

    return () => socket.close()
  }, [importId, queryClient])

  return { failed }
}

export function usePlaylistImport(importId: number | null) {
  const { failed } = usePlaylistImportSocket(importId)

  return useQuery({
    queryKey: importKeys.detail(importId),
    queryFn: () => apiFetch<PlaylistImport>(`/playlist-imports/${importId}`),
    enabled: importId !== null,
    // With the socket working this only runs once, for the initial state;
    // updates arrive by push. If the socket failed, poll instead.
    refetchInterval: (query) => {
      if (!failed) return false
      return isImportTerminal(query.state.data?.status) ? false : FALLBACK_POLL_INTERVAL_MS
    },
  })
}

export function useUpdateMatch(importId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      matchId: number
      status?: 'accepted' | 'rejected'
      chosenUrl?: string
    }) =>
      apiFetch<TrackMatch>(`/playlist-imports/${importId}/matches/${input.matchId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...(input.status !== undefined && { status: input.status }),
          ...(input.chosenUrl !== undefined && { chosen_url: input.chosenUrl }),
        }),
      }),
    // Refetch match pages and the importable count together.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.matchesRoot(importId) }),
  })
}

export function useBulkUpdateMatches(importId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { matchIds: number[]; status: 'accepted' | 'rejected' }) =>
      apiFetch<TrackMatch[]>(`/playlist-imports/${importId}/matches`, {
        method: 'PATCH',
        body: JSON.stringify({ match_ids: input.matchIds, status: input.status }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.matchesRoot(importId) }),
  })
}

export function useDeletePlaylistImport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (importId: number) =>
      apiFetch<void>(`/playlist-imports/${importId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: importKeys.list() }),
  })
}

/** Retry failed downloads — all of them, or one row. Most download failures
 *  are transient throttling, so this usually just works. */
export function useRetryFailed(importId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (matchId?: number) =>
      apiFetch<PlaylistImport>(
        matchId === undefined
          ? `/playlist-imports/${importId}/retry-failed`
          : `/playlist-imports/${importId}/matches/${matchId}/retry`,
        { method: 'POST' },
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(importKeys.detail(importId), updated)
      queryClient.invalidateQueries({ queryKey: importKeys.matchesRoot(importId) })
    },
  })
}

export function useConfirmImport(importId: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<PlaylistImport>(`/playlist-imports/${importId}/confirm`, { method: 'POST' }),
    // The 202 body is the authoritative "importing" state — write it straight
    // into the cache so the page flips without waiting for the socket.
    onSuccess: (updated) => queryClient.setQueryData(importKeys.detail(importId), updated),
  })
}

/** How many matches the confirm phase would import (auto-matched + accepted).
 *  Totals come from two limit-1 match queries, so the count stays correct
 *  however many pages the review table has. */
export function useImportableCount(importId: number) {
  return useQuery({
    queryKey: [...importKeys.matchesRoot(importId), 'importable-count'] as const,
    queryFn: async () => {
      const [autoMatched, accepted] = await Promise.all([
        apiFetch<Page<TrackMatch>>(
          `/playlist-imports/${importId}/matches${queryString({ status: 'auto_matched', limit: 1 })}`,
        ),
        apiFetch<Page<TrackMatch>>(
          `/playlist-imports/${importId}/matches${queryString({ status: 'accepted', limit: 1 })}`,
        ),
      ])
      return autoMatched.total + accepted.total
    },
  })
}
