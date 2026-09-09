import { useTranslation } from 'react-i18next'

interface ImportProgressProps {
  label: string
  value: number
  total: number | null
}

/** A numeric X-of-N progress bar — batch imports have real counts, unlike the
 *  stage-based single-job progress in JobProgress. */
export function ImportProgress({ label, value, total }: ImportProgressProps) {
  const { t } = useTranslation()
  const percent = total && total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0

  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800"
    >
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-medium text-slate-900 dark:text-slate-100">{label}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {total ? t('importProgress.ofTotal', { value, total }) : t('importProgress.starting')}
        </p>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className="h-full rounded-full bg-accent-600 transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
