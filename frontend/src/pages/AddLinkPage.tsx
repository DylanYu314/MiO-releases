import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { useCreateJob, useJob } from '../api/jobs'
import { songKeys } from '../api/songs'
import { JobProgress } from '../components/JobProgress'

export function AddLinkPage() {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  // The job pointer lives in the URL (?job=) so progress survives a reload and
  // can be shared, mirroring how ImportDetailPage keeps its state addressable.
  const [searchParams, setSearchParams] = useSearchParams()
  const jobParam = searchParams.get('job')
  const jobId = jobParam !== null && /^\d+$/.test(jobParam) ? Number(jobParam) : null
  const queryClient = useQueryClient()

  const createJob = useCreateJob()
  const { data: job } = useJob(jobId)

  // Once the download lands, the library list is stale — drop it so the new
  // song shows up when the user navigates back.
  useEffect(() => {
    if (job?.status === 'done') {
      queryClient.invalidateQueries({ queryKey: songKeys.all })
    }
  }, [job?.status, queryClient])

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return

    createJob.mutate(trimmed, {
      onSuccess: (created) => {
        setSearchParams({ job: String(created.id) })
        setUrl('')
      },
    })
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t('addLink.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t('addLink.description')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://..."
          aria-label={t('addLink.urlAria')}
          required
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:ring-accent-900"
        />
        <button
          type="submit"
          disabled={createJob.isPending}
          className="rounded-lg bg-accent-600 px-4 py-2 font-medium text-white transition hover:bg-accent-700 disabled:opacity-50"
        >
          {createJob.isPending ? t('addLink.adding') : t('addLink.add')}
        </button>
      </form>

      {createJob.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {createJob.error.message}
        </p>
      )}

      {job && <JobProgress job={job} />}
    </div>
  )
}
