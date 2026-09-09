import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import {
  useCreateYouTubeImport,
  useDeletePlaylistImport,
  usePlaylistImports,
} from '../api/playlistImports'
import { useSpotifyStatus } from '../api/spotify'
import { isImportTerminal, type PlaylistImport } from '../api/types'
import { ImportGate } from '../components/ImportGate'
import { SpotifyConnectCard } from '../components/SpotifyConnectCard'
import { SpotifyPlaylistPicker } from '../components/SpotifyPlaylistPicker'
import { Button, Card, Input } from '../components/ui'
import { useConfirm } from '../components/ui/confirm/context'
import { useToast } from '../components/ui/toast/context'

/** The ?spotify_error= slugs the OAuth callback can send, and their message
 *  keys. Translated at render, so the map itself stays a constant. */
const SPOTIFY_ERROR_KEYS: Record<string, string> = {
  access_denied: 'importPage.errors.accessDenied',
  state_mismatch: 'importPage.errors.stateMismatch',
  exchange_failed: 'importPage.errors.exchangeFailed',
}

export function ImportPage() {
  const { t } = useTranslation()
  // The OAuth callback lands here with ?connected= or ?spotify_error= after a
  // full-page round trip through Spotify, so the URL is the only channel the
  // backend has to report how it went.
  const [searchParams, setSearchParams] = useSearchParams()
  const connected = searchParams.get('connected')
  const spotifyError = searchParams.get('spotify_error')

  const dismissBanner = () => setSearchParams({}, { replace: true })

  const { data: status } = useSpotifyStatus()

  return (
    <ImportGate>
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {t('importPage.title')}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {t('importPage.description')}
          </p>
        </div>

        {connected !== null && (
          <div
            role="status"
            className="flex items-center justify-between gap-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300"
          >
            <span>{t('importPage.connected')}</span>
            <button type="button" onClick={dismissBanner} className="font-medium underline">
              {t('common.dismiss')}
            </button>
          </div>
        )}

        {spotifyError !== null && (
          <div
            role="alert"
            className="flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400"
          >
            <span>{t(SPOTIFY_ERROR_KEYS[spotifyError] ?? 'importPage.errors.generic')}</span>
            <button type="button" onClick={dismissBanner} className="font-medium underline">
              {t('common.dismiss')}
            </button>
          </div>
        )}

        {/* Anything still running goes up top so progress is the first thing seen. */}
        <ActiveImports />

        <YouTubeImportCard />

        <SpotifyConnectCard />

        {status?.configured && status.accounts.length > 0 && (
          <SpotifyPlaylistPicker accounts={status.accounts} />
        )}

        <RecentImports />
      </div>
    </ImportGate>
  )
}

function YouTubeImportCard() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [url, setUrl] = useState('')
  const createImport = useCreateYouTubeImport()

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = url.trim()
    if (!trimmed) return
    createImport.mutate(trimmed, {
      onSuccess: () => {
        setUrl('')
        toast(t('youtubeImport.started'), 'success')
      },
    })
  }

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">
          {t('youtubeImport.title')}
        </h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t('youtubeImport.description')}
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t('youtubeImport.urlPlaceholder')}
          aria-label={t('youtubeImport.title')}
          required
          className="flex-1"
        />
        <Button type="submit" loading={createImport.isPending}>
          {t('youtubeImport.import')}
        </Button>
      </form>
      {createImport.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {createImport.error.message}
        </p>
      )}
    </Card>
  )
}

/** Shared confirm-then-delete for an import record, used by both sections. */
function useImportDelete() {
  const { t } = useTranslation()
  const deleteImport = useDeletePlaylistImport()
  const confirm = useConfirm()

  async function handleDelete(playlistImport: PlaylistImport) {
    const ok = await confirm({
      title: t('importPage.deleteTitle'),
      message: t('importPage.deleteMessage', { name: playlistImport.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    })
    if (ok) deleteImport.mutate(playlistImport.id)
  }

  return { deleteImport, handleDelete }
}

function DeleteImportButton({
  playlistImport,
  deleteImport,
  onDelete,
}: {
  playlistImport: PlaylistImport
  deleteImport: ReturnType<typeof useDeletePlaylistImport>
  onDelete: (playlistImport: PlaylistImport) => void
}) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      onClick={() => onDelete(playlistImport)}
      disabled={deleteImport.isPending && deleteImport.variables === playlistImport.id}
      aria-label={t('importPage.deleteAria', { name: playlistImport.name })}
      className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
    >
      {t('common.delete')}
    </button>
  )
}

/** The two counting stages have real X-of-N progress; the rest just show a
 *  status pill. */
function activeProgress(imp: PlaylistImport): { value: number; total: number } | null {
  if (imp.status === 'matching' && imp.track_count)
    return { value: imp.matched_count, total: imp.track_count }
  if (imp.status === 'importing' && imp.import_total)
    return { value: imp.imported_count + imp.failed_count, total: imp.import_total }
  return null
}

function ActiveImports() {
  const { t } = useTranslation()
  const { data } = usePlaylistImports()
  const { deleteImport, handleDelete } = useImportDelete()

  const active = (data?.items ?? []).filter((imp) => !isImportTerminal(imp.status))
  if (active.length === 0) return null

  return (
    <section className="space-y-3">
      <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('import.inProgress')}</h3>
      <ul className="space-y-2">
        {active.map((imp) => {
          const progress = activeProgress(imp)
          const percent = progress
            ? Math.min(100, Math.round((progress.value / progress.total) * 100))
            : 0
          return (
            <li
              key={imp.id}
              className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800"
            >
              <div className="flex items-center gap-2">
                <Link
                  to={`/import/${imp.id}`}
                  className="min-w-0 flex-1 truncate font-medium text-slate-900 hover:underline dark:text-slate-100"
                >
                  {imp.name}
                </Link>
                <span className="shrink-0 rounded-full bg-accent-100 px-2 py-0.5 text-xs font-medium text-accent-700 dark:bg-accent-950 dark:text-accent-300">
                  {t(`importStatus.${imp.status}`)}
                </span>
                <DeleteImportButton
                  playlistImport={imp}
                  deleteImport={deleteImport}
                  onDelete={handleDelete}
                />
              </div>

              {progress && (
                <div className="mt-2 space-y-1">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                    <div
                      role="progressbar"
                      aria-valuenow={progress.value}
                      aria-valuemin={0}
                      aria-valuemax={progress.total}
                      className="h-full rounded-full bg-accent-600 transition-all"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {progress.value} / {progress.total}
                  </p>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {deleteImport.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {deleteImport.error.message}
        </p>
      )}
    </section>
  )
}

function RecentImports() {
  const { t } = useTranslation()
  const { data } = usePlaylistImports()
  const { deleteImport, handleDelete } = useImportDelete()

  const finished = (data?.items ?? []).filter((imp) => isImportTerminal(imp.status))
  if (finished.length === 0) return null

  return (
    <section className="space-y-3">
      <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('import.recent')}</h3>
      <ul className="space-y-2">
        {finished.map((playlistImport) => (
          <li
            key={playlistImport.id}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 transition hover:border-slate-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600"
          >
            <Link
              to={`/import/${playlistImport.id}`}
              className="flex min-w-0 flex-1 items-center gap-4"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                  {playlistImport.name}
                </p>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {new Date(playlistImport.created_at).toLocaleString()}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300">
                {t(`importStatus.${playlistImport.status}`)}
              </span>
            </Link>
            <DeleteImportButton
              playlistImport={playlistImport}
              deleteImport={deleteImport}
              onDelete={handleDelete}
            />
          </li>
        ))}
      </ul>

      {deleteImport.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {deleteImport.error.message}
        </p>
      )}
    </section>
  )
}
