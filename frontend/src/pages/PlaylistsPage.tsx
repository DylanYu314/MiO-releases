import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { useCreatePlaylist, useDeletePlaylist, usePlaylists } from '../api/playlists'
import type { Playlist } from '../api/types'
import { useConfirm } from '../components/ui/confirm/context'

export function PlaylistsPage() {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const { data, isPending, isError, error } = usePlaylists()
  const createPlaylist = useCreatePlaylist()
  const deletePlaylist = useDeletePlaylist()
  const confirm = useConfirm()

  function handleCreate(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    createPlaylist.mutate(trimmed, { onSuccess: () => setName('') })
  }

  async function handleDelete(playlist: Playlist) {
    const ok = await confirm({
      title: t('playlists.deleteTitle'),
      message: t('playlists.deleteMessage', { name: playlist.name }),
      confirmLabel: t('common.delete'),
      danger: true,
    })
    if (ok) deletePlaylist.mutate(playlist.id)
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleCreate} className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('playlists.namePlaceholder')}
          aria-label={t('playlists.nameAria')}
          maxLength={300}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:ring-accent-900"
        />
        <button
          type="submit"
          disabled={createPlaylist.isPending || name.trim() === ''}
          className="rounded-lg bg-accent-600 px-4 py-2 font-medium text-white transition hover:bg-accent-700 disabled:opacity-50"
        >
          {t('playlists.create')}
        </button>
      </form>

      {isPending && <p className="text-slate-500 dark:text-slate-400">{t('playlists.loading')}</p>}

      {isError && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {t('playlists.loadError', { message: error.message })}
        </p>
      )}

      {data && data.items.length === 0 && (
        <p className="text-slate-500 dark:text-slate-400">{t('playlists.empty')}</p>
      )}

      {data && data.items.length > 0 && (
        <ul className="space-y-2">
          {data.items.map((playlist) => (
            <li
              key={playlist.id}
              className="flex items-center gap-4 rounded-lg border border-slate-200 bg-white p-3 transition hover:border-slate-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600"
            >
              <Link
                to={playlist.kind === 'favourites' ? '/favourites' : `/playlists/${playlist.id}`}
                className="min-w-0 flex-1"
              >
                <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                  {playlist.name}
                </p>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {t('playlists.songCount', { count: playlist.item_count })}
                </p>
              </Link>

              {/* Favourites is managed by the heart button; the backend
                  refuses to delete it, so don't offer the action. */}
              <button
                type="button"
                hidden={playlist.kind === 'favourites'}
                onClick={() => handleDelete(playlist)}
                disabled={deletePlaylist.isPending && deletePlaylist.variables === playlist.id}
                aria-label={t('playlists.deleteAria', { name: playlist.name })}
                className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
              >
                {t('common.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
