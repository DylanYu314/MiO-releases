import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'

import {
  useConfirmImport,
  useImportableCount,
  usePlaylistImport,
  useRetryFailed,
} from '../api/playlistImports'
import type { PlaylistImport } from '../api/types'
import { ImportProgress } from '../components/ImportProgress'
import { MatchReviewTable } from '../components/MatchReviewTable'
import { WaitingForWorker } from '../components/WaitingForWorker'

export function ImportDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const importId = id ? Number(id) : null

  const { data: playlistImport, isPending, isError, error } = usePlaylistImport(importId)

  if (isPending) {
    return <p className="text-slate-500 dark:text-slate-400">{t('importDetail.loading')}</p>
  }

  if (isError) {
    return (
      <p role="alert" className="text-red-600 dark:text-red-400">
        {t('importDetail.loadError', { message: error.message })}
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t('importDetail.title', { name: playlistImport.name })}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {playlistImport.track_count !== null &&
            `${t('importDetail.trackCount', { count: playlistImport.track_count })} · `}
          {t('importDetail.from', { source: sourceLabel(playlistImport) })}
        </p>
      </div>

      <ImportBody playlistImport={playlistImport} />
    </div>
  )
}

/** Which source an import came from, for the "from …" labels. */
function sourceLabel(playlistImport: PlaylistImport): string {
  return playlistImport.service === 'youtube' ? 'YouTube' : 'Spotify'
}

function ImportBody({ playlistImport }: { playlistImport: PlaylistImport }) {
  const { t } = useTranslation()

  switch (playlistImport.status) {
    case 'queued':
    case 'fetching':
      return (
        <div role="status" className="space-y-2">
          <p className="text-slate-500 dark:text-slate-400">
            {t('importDetail.fetching', { source: sourceLabel(playlistImport) })}
          </p>
          {playlistImport.status === 'queued' && (
            <WaitingForWorker since={playlistImport.created_at} />
          )}
        </div>
      )

    case 'matching':
      return (
        <ImportProgress
          label={t('importDetail.matching')}
          value={playlistImport.matched_count}
          total={playlistImport.track_count}
        />
      )

    case 'review':
      return <ReviewStage playlistImport={playlistImport} />

    case 'importing':
      return (
        <div className="space-y-4">
          <ImportProgress
            label={t('importDetail.downloading')}
            value={playlistImport.imported_count + playlistImport.failed_count}
            total={playlistImport.import_total}
          />
          <MatchReviewTable importId={playlistImport.id} />
        </div>
      )

    case 'done':
      return <DoneStage playlistImport={playlistImport} />

    case 'failed':
      return (
        <p
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400"
        >
          {t('importDetail.failed', {
            message: playlistImport.error ?? t('importDetail.unknownError'),
          })}
        </p>
      )
  }
}

function DoneStage({ playlistImport }: { playlistImport: PlaylistImport }) {
  const { t } = useTranslation()
  const retryFailed = useRetryFailed(playlistImport.id)
  const failedCount = playlistImport.failed_count

  return (
    <div className="space-y-4">
      <div
        role="status"
        className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
      >
        {failedCount > 0
          ? t('importDetail.finishedWithFailures', {
              count: playlistImport.imported_count,
              failed: failedCount,
            })
          : t('importDetail.finished', { count: playlistImport.imported_count })}
        .{' '}
        {playlistImport.playlist_id !== null && (
          <Link to={`/playlists/${playlistImport.playlist_id}`} className="font-medium underline">
            {t('importDetail.openPlaylist')}
          </Link>
        )}
      </div>

      {failedCount > 0 && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t('importDetail.failedHint', { count: failedCount })}
          </p>
          <button
            type="button"
            onClick={() => retryFailed.mutate(undefined)}
            disabled={retryFailed.isPending}
            className="shrink-0 rounded-lg bg-accent-600 px-4 py-2 font-medium text-white transition hover:bg-accent-700 disabled:opacity-50"
          >
            {retryFailed.isPending ? t('common.starting') : t('importDetail.retryFailed')}
          </button>
        </div>
      )}

      {retryFailed.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {retryFailed.error.message}
        </p>
      )}

      <MatchReviewTable importId={playlistImport.id} retryable />
    </div>
  )
}

function ReviewStage({ playlistImport }: { playlistImport: PlaylistImport }) {
  const { t } = useTranslation()
  const { data: importableCount } = useImportableCount(playlistImport.id)
  const confirmImport = useConfirmImport(playlistImport.id)
  const count = importableCount ?? 0

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('importDetail.reviewHint')}</p>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('importDetail.readyToImport', { count })}
        </p>
        <button
          type="button"
          onClick={() => confirmImport.mutate()}
          disabled={count === 0 || confirmImport.isPending}
          className="rounded-lg bg-accent-600 px-4 py-2 font-medium text-white transition hover:bg-accent-700 disabled:opacity-50"
        >
          {confirmImport.isPending ? t('common.starting') : t('importDetail.confirm')}
        </button>
      </div>

      {confirmImport.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {confirmImport.error.message}
        </p>
      )}

      <MatchReviewTable importId={playlistImport.id} interactive />
    </div>
  )
}
