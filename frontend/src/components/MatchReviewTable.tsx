import { ChevronDown, ExternalLink } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  MATCHES_PAGE_LIMIT,
  useBulkUpdateMatches,
  useImportMatches,
  useRetryFailed,
  useUpdateMatch,
  type MatchStatusFilter,
} from '../api/playlistImports'
import type { TrackMatch } from '../api/types'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { useSelection } from '../hooks/useSelection'
import { formatDuration } from '../lib/format'
import { Pagination } from './Pagination'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'

// Filter values → their i18n key; the label is resolved at render.
const REVIEW_FILTER_TABS: MatchStatusFilter[] = ['all', 'auto_matched', 'needs_review', 'no_match']

/** Once downloads have run, "did it work?" is the interesting question. */
const RESULT_FILTER_TABS: MatchStatusFilter[] = ['all', 'imported', 'failed', 'no_match']

type UpdateInput = { matchId: number; status?: 'accepted' | 'rejected'; chosenUrl?: string }

interface MatchReviewTableProps {
  importId: number
  /** When true (review state) rows get Accept / Reject / Change controls. */
  interactive?: boolean
  /** When true (a finished import) failed rows get a Retry button. */
  retryable?: boolean
}

export function MatchReviewTable({
  importId,
  interactive = false,
  retryable = false,
}: MatchReviewTableProps) {
  const { t } = useTranslation()
  const [statusFilter, setStatusFilter] = useState<MatchStatusFilter>('all')
  const [offset, setOffset] = useState(0)

  const { data, isPending, isError, error } = useImportMatches(importId, statusFilter, offset)
  const updateMatch = useUpdateMatch(importId)
  const bulkUpdate = useBulkUpdateMatches(importId)
  const retryFailed = useRetryFailed(importId)
  const selection = useSelection<number>()
  const tabs = interactive ? REVIEW_FILTER_TABS : RESULT_FILTER_TABS

  function handleFilterChange(value: MatchStatusFilter) {
    setStatusFilter(value)
    setOffset(0) // New filter, new list — page 1. Reset here, not in an effect.
    selection.clear() // Selection is scoped to the visible page.
  }

  function handleOffsetChange(next: number) {
    setOffset(next)
    selection.clear()
  }

  function runBulk(status: 'accepted' | 'rejected') {
    bulkUpdate.mutate({ matchIds: selection.ids, status }, { onSuccess: () => selection.clear() })
  }

  const visibleIds = data?.items.map((match) => match.id) ?? []
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selection.isSelected(id))

  return (
    <section className="space-y-4">
      <div role="tablist" aria-label={t('matchReview.filterAria')} className="flex flex-wrap gap-1">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={statusFilter === value}
            onClick={() => handleFilterChange(value)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              statusFilter === value
                ? 'bg-accent-600 text-white'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {t(`matchFilter.${value}`)}
          </button>
        ))}
      </div>

      {isPending && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('matchReview.loading')}</p>
      )}

      {isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('matchReview.loadError', { message: error.message })}
        </p>
      )}

      {updateMatch.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {updateMatch.error.message}
        </p>
      )}

      {retryFailed.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {retryFailed.error.message}
        </p>
      )}

      {bulkUpdate.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {bulkUpdate.error.message}
        </p>
      )}

      {interactive && data && data.items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <Checkbox
              checked={allSelected}
              onChange={() => (allSelected ? selection.clear() : selection.set(visibleIds))}
              aria-label={t('bulk.selectAll')}
            />
            {selection.count > 0
              ? t('bulk.selectedCount', { count: selection.count })
              : t('bulk.selectAll')}
          </label>

          {selection.count > 0 && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => runBulk('accepted')}
                loading={bulkUpdate.isPending}
              >
                {t('bulk.accept')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => runBulk('rejected')}
                loading={bulkUpdate.isPending}
              >
                {t('bulk.reject')}
              </Button>
              <Button size="sm" variant="ghost" onClick={selection.clear}>
                {t('bulk.clear')}
              </Button>
            </div>
          )}
        </div>
      )}

      {data && data.items.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('matchReview.nothingHere')}</p>
      )}

      {data && data.items.length > 0 && (
        <ul className="space-y-2">
          {data.items.map((match) => (
            <MatchRow
              key={match.id}
              match={match}
              interactive={interactive}
              retryable={retryable}
              selected={selection.isSelected(match.id)}
              onToggleSelect={() => selection.toggle(match.id)}
              isBusy={
                (updateMatch.isPending && updateMatch.variables?.matchId === match.id) ||
                (retryFailed.isPending && retryFailed.variables === match.id)
              }
              onUpdate={(input) => updateMatch.mutate(input)}
              onRetry={() => retryFailed.mutate(match.id)}
            />
          ))}
        </ul>
      )}

      {data && (
        <Pagination
          total={data.total}
          limit={MATCHES_PAGE_LIMIT}
          offset={offset}
          onOffsetChange={handleOffsetChange}
        />
      )}
    </section>
  )
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const percent = Math.round(confidence * 100)
  const tone =
    confidence >= 0.8
      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
      : confidence >= 0.55
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {percent}%
    </span>
  )
}

function MatchRow({
  match,
  interactive,
  retryable,
  selected,
  onToggleSelect,
  isBusy,
  onUpdate,
  onRetry,
}: {
  match: TrackMatch
  interactive: boolean
  retryable: boolean
  selected: boolean
  onToggleSelect: () => void
  isBusy: boolean
  onUpdate: (input: UpdateInput) => void
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const chosenCandidate = match.candidates.find((c) => c.url === match.chosen_url)

  return (
    <li className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center gap-3">
        {interactive && (
          <Checkbox
            checked={selected}
            onChange={onToggleSelect}
            aria-label={t('bulk.selectRow', { title: match.title })}
          />
        )}
        <span className="w-8 shrink-0 text-right text-sm text-slate-400 dark:text-slate-500">
          {match.position + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-slate-900 dark:text-slate-100">{match.title}</p>
          <p className="truncate text-sm text-slate-500 dark:text-slate-400">
            {match.artist}
            {match.duration_s !== null && ` · ${formatDuration(match.duration_s)}`}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {t(`matchStatus.${match.status}`)}
        </span>
      </div>

      {/* What the matcher (or the user) picked, indented under the track. */}
      <div className="ml-11 flex items-center gap-3 rounded-lg bg-slate-50 p-2 dark:bg-slate-900">
        {match.chosen_url ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-slate-700 dark:text-slate-300">
                {chosenCandidate?.title ?? match.chosen_url}
              </p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                {chosenCandidate
                  ? `${chosenCandidate.uploader ?? t('matchReview.unknownChannel')}${
                      chosenCandidate.duration != null
                        ? ` · ${formatDuration(chosenCandidate.duration)}`
                        : ''
                    }`
                  : t('matchReview.customUrl')}
              </p>
            </div>
            {match.confidence !== null && <ConfidenceBadge confidence={match.confidence} />}
            <a
              href={match.chosen_url}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-sm font-medium text-accent-600 hover:underline dark:text-accent-400"
            >
              <span className="inline-flex items-center gap-1">
                {t('matchReview.listen')} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </span>
            </a>
          </>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {match.error
              ? `${t('matchReview.noCandidate')} — ${match.error}`
              : `${t('matchReview.noCandidate')}.`}
          </p>
        )}
      </div>

      {retryable && match.status === 'failed' && (
        <div className="ml-11 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRetry}
            disabled={isBusy}
            className="rounded px-2 py-1 text-sm font-medium text-accent-600 transition hover:bg-accent-50 disabled:opacity-50 dark:text-accent-400 dark:hover:bg-accent-950"
          >
            {isBusy ? t('matchReview.retrying') : t('matchReview.retryDownload')}
          </button>
          {match.error && (
            <span className="truncate text-xs text-slate-500 dark:text-slate-400">
              {match.error}
            </span>
          )}
        </div>
      )}

      {interactive && (
        <div className="ml-11 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onUpdate({ matchId: match.id, status: 'accepted' })}
            disabled={isBusy || match.chosen_url === null || match.status === 'accepted'}
            title={match.chosen_url === null ? t('matchReview.pickUrlFirst') : undefined}
            className="rounded px-2 py-1 text-sm font-medium text-green-700 transition hover:bg-green-50 disabled:opacity-50 dark:text-green-400 dark:hover:bg-green-950"
          >
            {t('matchReview.accept')}
          </button>
          <button
            type="button"
            onClick={() => onUpdate({ matchId: match.id, status: 'rejected' })}
            disabled={isBusy || match.status === 'rejected'}
            className="rounded px-2 py-1 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
          >
            {t('matchReview.reject')}
          </button>
          <CandidateMenu
            match={match}
            disabled={isBusy}
            onPick={(url) => onUpdate({ matchId: match.id, chosenUrl: url })}
          />
        </div>
      )}
    </li>
  )
}

function CandidateMenu({
  match,
  disabled,
  onPick,
}: {
  match: TrackMatch
  disabled: boolean
  onPick: (url: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customUrl, setCustomUrl] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()

  useOutsideClick(containerRef, () => setOpen(false), open)

  function handlePick(url: string) {
    onPick(url)
    setOpen(false)
  }

  function handleCustomSave(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = customUrl.trim()
    if (!trimmed) return
    onPick(trimmed)
    setOpen(false)
    setCustomOpen(false)
    setCustomUrl('')
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
      >
        <span className="inline-flex items-center gap-1">
          {t('matchReview.change')} <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 z-10 mt-1 max-h-72 w-72 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
        >
          {match.candidates.map((candidate) => (
            <button
              key={candidate.url}
              type="button"
              role="menuitem"
              onClick={() => handlePick(candidate.url)}
              className="block w-full px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <span className="block truncate">{candidate.title}</span>
              <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                {candidate.uploader ?? t('matchReview.unknownChannel')}
                {candidate.duration != null && ` · ${formatDuration(candidate.duration)}`}
                {candidate.score != null && ` · ${Math.round(candidate.score * 100)}%`}
              </span>
            </button>
          ))}

          {match.candidates.length === 0 && (
            <p className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              {t('matchReview.noCandidates')}
            </p>
          )}

          {!customOpen ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => setCustomOpen(true)}
              className="block w-full px-3 py-2 text-left text-sm font-medium text-accent-600 transition hover:bg-slate-100 dark:text-accent-400 dark:hover:bg-slate-700"
            >
              {t('matchReview.customUrlAction')}
            </button>
          ) : (
            <form onSubmit={handleCustomSave} className="flex gap-1 px-3 py-2">
              <input
                type="url"
                value={customUrl}
                onChange={(event) => setCustomUrl(event.target.value)}
                placeholder="https://..."
                aria-label={t('matchReview.customUrl')}
                className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-sm outline-none focus:border-accent-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="submit"
                className="rounded bg-accent-600 px-2 py-1 text-sm font-medium text-white transition hover:bg-accent-700"
              >
                {t('common.save')}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
