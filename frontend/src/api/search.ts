import { useQuery } from '@tanstack/react-query'

import { apiFetch, queryString } from './client'
import type { SearchPlatform, SearchResult } from './types'

export const searchKeys = {
  query: (platform: SearchPlatform, q: string) => ['search', platform, q] as const,
}

/**
 * Search a source for videos to import. Enabled only for a non-empty query, so
 * it fires on submit rather than on every keystroke — a search hits the upstream
 * extractor and is comparatively slow.
 */
export function useSearch(platform: SearchPlatform, q: string) {
  return useQuery({
    queryKey: searchKeys.query(platform, q),
    queryFn: () => apiFetch<SearchResult[]>(`/search${queryString({ q, platform })}`),
    enabled: q.length > 0,
    // Results don't go stale in a session, and the query is expensive — keep
    // them around so revisiting a search doesn't refetch.
    staleTime: 5 * 60 * 1000,
  })
}
