import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useFavouriteIds, useToggleFavourite } from '../api/playlists'
import { songCoverUrl } from '../api/songs'
import type { Song } from '../api/types'
import { formatDuration } from '../lib/format'
import { AddToPlaylistButton } from './AddToPlaylistButton'
import { Heart, ListStart, Pause, Play } from 'lucide-react'

interface SongRowProps {
  song: Song
  onPlay: (song: Song) => void
  onAddToQueue: (song: Song) => void
  /** Optional: rows in views without a player context can omit it. */
  onPlayNext?: (song: Song) => void
  onDelete: (song: Song) => void
  isDeleting?: boolean
  isCurrent: boolean
  isPlaying: boolean
  /** 1-based position shown at the start of the row, in ordered views. */
  position?: number
  /** Context-specific controls (reorder, remove-from-playlist), rendered
   *  before the actions every song has wherever it appears. */
  actions?: ReactNode
}

/**
 * One song, rendered the same way everywhere it appears.
 *
 * A song in a playlist is still a song: it can be queued, added to another
 * playlist and deleted, exactly as in the library. Context-specific controls
 * come in through `actions` rather than by forking the markup.
 */
export function SongRow({
  song,
  onPlay,
  onAddToQueue,
  onPlayNext,
  onDelete,
  isDeleting = false,
  isCurrent,
  isPlaying,
  position,
  actions,
}: SongRowProps) {
  const { t } = useTranslation()
  const { data: favouriteIds } = useFavouriteIds()
  const toggleFavourite = useToggleFavourite()
  const isFavourite = favouriteIds?.has(song.id) ?? false

  return (
    <li
      className={`flex items-center gap-3 rounded-lg border bg-white p-3 transition hover:shadow-sm dark:bg-slate-800 ${
        isCurrent
          ? 'border-accent-400 dark:border-accent-500'
          : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
      }`}
    >
      {position !== undefined && (
        <span className="w-6 shrink-0 text-right text-sm tabular-nums text-slate-400">
          {position}
        </span>
      )}

      <button
        type="button"
        onClick={() => onPlay(song)}
        aria-label={
          isCurrent && isPlaying
            ? t('song.pauseAria', { title: song.title })
            : t('song.playAria', { title: song.title })
        }
        className="relative h-12 w-12 shrink-0 overflow-hidden rounded"
      >
        <img
          src={songCoverUrl(song.id)}
          alt=""
          className="h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.style.visibility = 'hidden'
          }}
        />
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 transition hover:opacity-100">
          {isCurrent && isPlaying ? (
            <Pause className="h-4 w-4" aria-hidden />
          ) : (
            <Play className="h-4 w-4" aria-hidden />
          )}
        </span>
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={`truncate font-medium ${
            isCurrent
              ? 'text-accent-600 dark:text-accent-400'
              : 'text-slate-900 dark:text-slate-100'
          }`}
        >
          {song.title}
        </p>
        <p className="truncate text-sm text-slate-500 dark:text-slate-400">
          {song.artist}
          {song.album ? ` — ${song.album}` : ''}
        </p>
      </div>

      <span className="shrink-0 text-sm tabular-nums text-slate-500 dark:text-slate-400">
        {formatDuration(song.duration)}
      </span>

      {actions}

      <button
        type="button"
        onClick={() => toggleFavourite.mutate({ songId: song.id, favourite: !isFavourite })}
        aria-pressed={isFavourite}
        aria-label={
          isFavourite
            ? t('song.unfavouriteAria', { title: song.title })
            : t('song.favouriteAria', { title: song.title })
        }
        className={`shrink-0 rounded p-1.5 transition ${
          isFavourite
            ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950'
            : 'text-slate-400 hover:bg-slate-100 hover:text-red-500 dark:hover:bg-slate-700'
        }`}
      >
        <Heart className="h-4 w-4" aria-hidden fill={isFavourite ? 'currentColor' : 'none'} />
      </button>

      {onPlayNext && (
        <button
          type="button"
          onClick={() => onPlayNext(song)}
          aria-label={t('song.playNextAria', { title: song.title })}
          title={t('song.playNext')}
          className="shrink-0 rounded p-1.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
        >
          <ListStart className="h-4 w-4" aria-hidden />
        </button>
      )}

      <button
        type="button"
        onClick={() => onAddToQueue(song)}
        aria-label={t('song.addToQueueAria', { title: song.title })}
        className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
      >
        {t('song.queue')}
      </button>

      <AddToPlaylistButton song={song} />

      <button
        type="button"
        onClick={() => onDelete(song)}
        disabled={isDeleting}
        className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
        aria-label={t('song.deleteAria', { title: song.title })}
      >
        {t('song.delete')}
      </button>
    </li>
  )
}
