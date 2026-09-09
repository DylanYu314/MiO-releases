import { useTranslation } from 'react-i18next'

interface PaginationProps {
  total: number
  limit: number
  offset: number
  onOffsetChange: (offset: number) => void
}

/** After a page change the viewport is usually scrolled down; return to the top
 *  so the new page starts at the beginning. Instant when the user prefers
 *  reduced motion. */
function scrollToTop() {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
}

export function Pagination({ total, limit, offset, onOffsetChange }: PaginationProps) {
  const { t } = useTranslation()
  const page = Math.floor(offset / limit) + 1
  const pageCount = Math.max(1, Math.ceil(total / limit))
  const canGoBack = offset > 0
  const canGoForward = offset + limit < total

  if (total === 0) return null

  function goTo(nextOffset: number) {
    onOffsetChange(nextOffset)
    scrollToTop()
  }

  return (
    <div className="flex items-center justify-between gap-4 text-sm text-slate-600 dark:text-slate-400">
      <span>{t('pagination.songCount', { count: total })}</span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => goTo(Math.max(0, offset - limit))}
          disabled={!canGoBack}
          className="rounded border border-slate-300 px-3 py-1 transition enabled:hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:enabled:hover:bg-slate-700"
        >
          {t('pagination.previous')}
        </button>
        <span aria-live="polite">{t('pagination.pageOf', { page, pageCount })}</span>
        <button
          type="button"
          onClick={() => goTo(offset + limit)}
          disabled={!canGoForward}
          className="rounded border border-slate-300 px-3 py-1 transition enabled:hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:enabled:hover:bg-slate-700"
        >
          {t('pagination.next')}
        </button>
      </div>
    </div>
  )
}
