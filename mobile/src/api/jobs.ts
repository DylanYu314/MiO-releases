import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiFetch } from './client'
import { useConnection } from './connection'
import { isTerminal, type Job } from './types'

/** Fallback poll interval, used only if the WebSocket can't be established. */
const FALLBACK_POLL_INTERVAL_MS = 1000

export const jobKeys = {
  detail: (jobId: number | null) => ['jobs', jobId] as const,
}

export function useCreateJob() {
  return useMutation({
    mutationFn: (url: string) =>
      apiFetch<Job>('/jobs', { method: 'POST', body: JSON.stringify({ url }) }),
  })
}

/**
 * The progress socket's address.
 *
 * The web client derives this from `window.location`, which a phone has no
 * equivalent of — the server is wherever the user's `serverUrl` points. So it
 * is rewritten from that instead, swapping the scheme: `https` → `wss`,
 * anything else → `ws`.
 */
export function jobSocketUrl(serverUrl: string, jobId: number): string {
  const base = serverUrl.replace(/^http/i, (match) => (match === 'HTTP' ? 'WS' : 'ws'))
  return `${base}/jobs/${jobId}/ws`
}

/**
 * Subscribe to a job's progress, writing each update straight into the query
 * cache so `useJob` re-renders without refetching.
 *
 * Returns whether the socket failed, so the caller can fall back to polling. A
 * phone loses connectivity far more often than a desktop browser does, so that
 * fallback matters more here than it does on the web.
 */
function useJobSocket(jobId: number | null): { failed: boolean } {
  const queryClient = useQueryClient()
  const serverUrl = useConnection((state) => state.serverUrl)
  // Records *which* job failed rather than a bare boolean, so the flag is
  // derived during render instead of needing a reset effect.
  const [failedJobId, setFailedJobId] = useState<number | null>(null)
  const failed = jobId !== null && failedJobId === jobId
  // A ref, so the effect does not re-run (and reconnect) on every render.
  const receivedRef = useRef(false)

  useEffect(() => {
    if (jobId === null || !serverUrl) return
    receivedRef.current = false

    const socket = new WebSocket(jobSocketUrl(serverUrl, jobId))

    socket.onmessage = (event) => {
      try {
        const job = JSON.parse(event.data as string) as Job
        receivedRef.current = true
        queryClient.setQueryData(jobKeys.detail(jobId), job)
      } catch {
        // Ignore a frame that isn't a job payload rather than tearing down the
        // connection over one bad message.
      }
    }

    socket.onerror = () => setFailedJobId(jobId)

    socket.onclose = (event) => {
      // The server closes cleanly once a job finishes, which is not a failure.
      // Anything else, before a single message arrived, means we never really
      // connected — so the caller should poll instead.
      if (!event.wasClean && !receivedRef.current) setFailedJobId(jobId)
    }

    return () => socket.close()
  }, [jobId, serverUrl, queryClient])

  return { failed }
}

export function useJob(jobId: number | null) {
  const { failed } = useJobSocket(jobId)

  return useQuery({
    queryKey: jobKeys.detail(jobId),
    queryFn: () => apiFetch<Job>(`/jobs/${jobId}`),
    enabled: jobId !== null,
    // With the socket working this runs once, for the initial state; updates
    // arrive by push. If the socket failed, poll so progress still works.
    refetchInterval: (query) => {
      if (!failed) return false
      return isTerminal(query.state.data?.status) ? false : FALLBACK_POLL_INTERVAL_MS
    },
  })
}
