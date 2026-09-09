import { useQuery } from '@tanstack/react-query'

import { apiFetch, queryString } from './client'
import type { Page } from './types'

/**
 * Reading what the clients reported (#322).
 *
 * The endpoint has existed since #136 and **nothing has ever read it** — zero
 * references in this app until now. That is the whole reason crashes felt
 * absent: they were being stored faithfully and never looked at. Since #322 the
 * same table also carries the phone's daily log, which makes a reader the
 * difference between having diagnostics and merely collecting them.
 *
 * A laptop is where a log is actually read, which is why the reader is here
 * rather than only on the phone that produced it.
 */

export type ClientErrorLevel = 'error' | 'warn' | 'info'

export interface ClientError {
  id: number
  platform: string
  message: string
  stack: string | null
  description: string | null
  app_version: string | null
  os_version: string | null
  device: string | null
  level: ClientErrorLevel
  /** Which install sent it — the `installs` row id, not the client's token. */
  owner_install_id: number | null
  created_at: string
}

export const CLIENT_ERRORS_PAGE_LIMIT = 50

export type ClientErrorLevelFilter = ClientErrorLevel | 'all'

export const clientErrorKeys = {
  all: ['client-errors'] as const,
  list: (level: ClientErrorLevelFilter, offset: number) =>
    [...clientErrorKeys.all, 'list', level, offset] as const,
}

export function useClientErrors(
  level: ClientErrorLevelFilter,
  offset: number,
  /** Only an administrator may read these (#354); anyone else would get a 403. */
  enabled: boolean,
) {
  return useQuery({
    enabled,
    queryKey: clientErrorKeys.list(level, offset),
    queryFn: () =>
      apiFetch<Page<ClientError>>(
        `/client-errors${queryString({
          limit: CLIENT_ERRORS_PAGE_LIMIT,
          offset,
          ...(level === 'all' ? {} : { level }),
        })}`,
      ),
    // A page someone opens *because* something is going wrong. Anything stale
    // here is actively misleading — the question is always "what just
    // happened", never "what happened when this page was first opened".
    staleTime: 0,
  })
}
