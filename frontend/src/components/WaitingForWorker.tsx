import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** How long "queued" is normal before it's worth mentioning. */
const PATIENCE_MS = 15_000

interface WaitingForWorkerProps {
  /** When the work was queued (an ISO timestamp from the backend). */
  since: string
}

/**
 * Says so when queued work hasn't started.
 *
 * Since jobs moved into worker processes (ADR-006), "accepted but nothing
 * happens" became a real failure mode: if no worker is running, the queue
 * takes the message and it sits there. A spinner would imply progress that
 * isn't happening.
 */
export function WaitingForWorker({ since }: WaitingForWorkerProps) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])

  const queuedFor = now - new Date(since).getTime()
  if (queuedFor < PATIENCE_MS) return null

  return <p className="text-sm text-amber-700 dark:text-amber-400">{t('worker.waiting')}</p>
}
