import { useTranslation } from 'react-i18next'

import { JOB_PROGRESS_STEPS, type Job } from '../api/types'
import { WaitingForWorker } from './WaitingForWorker'

interface JobProgressProps {
  job: Job
}

/** Visualises the backend's job state machine (see ADR-001). */
export function JobProgress({ job }: JobProgressProps) {
  const { t } = useTranslation()

  if (job.status === 'failed') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950"
      >
        <p className="font-medium text-red-800 dark:text-red-300">{t('jobProgress.failed')}</p>
        {/*
         * A sentence about what happened, not yt-dlp's output (#177). The raw
         * text moves into a `<details>` — still one click away for whoever needs
         * it, and no longer the first thing a user reads.
         */}
        <p className="mt-1 break-words text-sm text-red-700 dark:text-red-400">
          {job.error_code ? t(`failure.${job.error_code}`) : t('jobProgress.noError')}
        </p>
        {job.error ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-red-700/70 dark:text-red-400/70">
              {t('jobProgress.technicalDetail')}
            </summary>
            <p className="mt-1 break-words font-mono text-xs text-red-700/70 dark:text-red-400/70">
              {job.error}
            </p>
          </details>
        ) : null}
      </div>
    )
  }

  if (job.status === 'done') {
    return (
      <div
        role="status"
        className="rounded-lg border border-green-300 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950"
      >
        <p className="font-medium text-green-800 dark:text-green-300">{t('jobProgress.done')}</p>
      </div>
    )
  }

  const currentIndex = JOB_PROGRESS_STEPS.indexOf(job.status)

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800"
    >
      <p className="mb-3 font-medium text-slate-900 dark:text-slate-100">
        {t('jobProgress.inProgress', { status: t(`jobStatus.${job.status}`) })}
      </p>
      <ol className="flex gap-2">
        {JOB_PROGRESS_STEPS.map((step, index) => (
          <li key={step} className="flex-1">
            <div
              className={`h-1.5 rounded-full transition-colors ${
                index <= currentIndex ? 'bg-accent-500' : 'bg-slate-200 dark:bg-slate-600'
              }`}
            />
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              {t(`jobStatus.${step}`)}
            </span>
          </li>
        ))}
      </ol>
      {job.status === 'queued' && <WaitingForWorker since={job.created_at} />}
    </div>
  )
}
