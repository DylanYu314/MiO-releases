import { useQuery } from '@tanstack/react-query'

import { apiFetch } from './client'

export interface AccessStatus {
  /** Whether importing is gated on this server at all. */
  locked: boolean
  /** Whether this client's stored key currently gets through the gate. */
  unlocked: boolean
  /**
   * Whether this key may read everyone's diagnostics (#354).
   *
   * **Independent of `unlocked`, not implied by it.** Every invited tester is
   * unlocked and almost none are administrators — which is exactly why the
   * diagnostics page gates on this and not on that.
   */
  admin: boolean
}

export const ACCESS_STATUS_KEY = ['access-status'] as const

export function useAccessStatus() {
  return useQuery({
    queryKey: ACCESS_STATUS_KEY,
    queryFn: () => apiFetch<AccessStatus>('/access/status'),
  })
}
