import { getInstallId } from './installId'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { apiFetch } from './client'
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

function jobSocketUrl(jobId: number): string {
  // Same host as the page, so the Vite dev proxy (and any future reverse proxy)
  // handles it; ws:// on http pages, wss:// on https.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/jobs/${jobId}/ws?install=${encodeURIComponent(getInstallId() ?? '')}`
}

/**
 * Subscribe to a job's progress over a WebSocket, writing each update straight
 * into the query cache so `useJob` re-renders without refetching.
 *
 * Returns whether the socket failed, so the caller can fall back to polling.
 */
function useJobSocket(jobId: number | null): { failed: boolean } {
  const queryClient = useQueryClient()
  // Records *which* job the socket failed for, rather than a bare boolean that
  // would need resetting in the effect — deriving it during render instead
  // avoids the extra render pass a reset would cause.
  const [failedJobId, setFailedJobId] = useState<number | null>(null)
  const failed = jobId !== null && failedJobId === jobId
  // Held in a ref so the effect doesn't re-run (and reconnect) on every render.
  const receivedRef = useRef(false)

  useEffect(() => {
    if (jobId === null) return
    receivedRef.current = false

    // Not wrapped in try/catch: the constructor only throws on a malformed URL,
    // and this one is built from window.location. Real failures (server down,
    // connection refused) arrive via onerror/onclose below.
    const socket = new WebSocket(jobSocketUrl(jobId))

    socket.onmessage = (event) => {
      try {
        const job = JSON.parse(event.data) as Job
        receivedRef.current = true
        queryClient.setQueryData(jobKeys.detail(jobId), job)
      } catch {
        // Ignore anything that isn't a job payload rather than tearing down
        // the connection over one bad frame.
      }
    }

    socket.onerror = () => setFailedJobId(jobId)

    socket.onclose = (event) => {
      // The server closes cleanly once a job finishes, which is not a failure.
      // Anything else before a single message arrived means we never really
      // connected, so the caller should poll instead.
      if (!event.wasClean && !receivedRef.current) setFailedJobId(jobId)
    }

    return () => socket.close()
  }, [jobId, queryClient])

  return { failed }
}

export function useJob(jobId: number | null) {
  const { failed } = useJobSocket(jobId)

  return useQuery({
    queryKey: jobKeys.detail(jobId),
    queryFn: () => apiFetch<Job>(`/jobs/${jobId}`),
    enabled: jobId !== null,
    // With the socket working this only runs once, for the initial state;
    // updates arrive by push. If the socket failed, fall back to polling so
    // progress still works.
    refetchInterval: (query) => {
      if (!failed) return false
      return isTerminal(query.state.data?.status) ? false : FALLBACK_POLL_INTERVAL_MS
    },
  })
}
