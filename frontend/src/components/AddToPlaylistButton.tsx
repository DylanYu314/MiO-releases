import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAddPlaylistItem, usePlaylists } from '../api/playlists'
import type { Song } from '../api/types'
import { useOutsideClick } from '../hooks/useOutsideClick'
import { Plus } from 'lucide-react'

interface AddToPlaylistButtonProps {
  song: Song
}

export function AddToPlaylistButton({ song }: AddToPlaylistButtonProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const { data } = usePlaylists()
  const addItem = useAddPlaylistItem()

  useOutsideClick(containerRef, () => setOpen(false), open)

  const playlists = data?.items ?? []

  function handleAdd(playlistId: number) {
    addItem.mutate({ playlistId, songId: song.id })
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('song.addToPlaylistAria', { title: song.title })}
        className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
      >
        <span className="inline-flex items-center gap-1">
          <Plus className="h-4 w-4" aria-hidden /> {t('song.playlist')}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 max-h-64 w-56 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
        >
          {playlists.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
              {t('song.noPlaylists')}
            </p>
          ) : (
            playlists.map((playlist) => (
              <button
                key={playlist.id}
                type="button"
                role="menuitem"
                onClick={() => handleAdd(playlist.id)}
                className="block w-full truncate px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {playlist.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
