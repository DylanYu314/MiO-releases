import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'

import {
  usePlaylist,
  useRemovePlaylistItem,
  useRenamePlaylist,
  useReorderPlaylist,
} from '../api/playlists'
import { useDeleteSong } from '../api/songs'
import type { PlaylistItem, Song } from '../api/types'
import { SongRow } from '../components/SongRow'
import { useConfirm } from '../components/ui/confirm/context'
import { selectCurrentSong, usePlayerStore } from '../player/store'
import { ArrowDown, ArrowLeft, ArrowUp, Play } from 'lucide-react'

export function PlaylistDetailPage() {
  const { t } = useTranslation()
  const params = useParams<{ id: string }>()
  const playlistId = params.id ? Number(params.id) : null

  const { data: playlist, isPending, isError, error } = usePlaylist(playlistId)
  const rename = useRenamePlaylist()
  const removeItem = useRemovePlaylistItem()
  const reorder = useReorderPlaylist()
  const deleteSong = useDeleteSong()
  const confirm = useConfirm()

  const currentSong = usePlayerStore(selectCurrentSong)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const playFromContext = usePlayerStore((state) => state.playFromContext)
  const togglePlay = usePlayerStore((state) => state.togglePlay)
  const addToQueue = usePlayerStore((state) => state.addToQueue)
  const playNext = usePlayerStore((state) => state.playNext)

  const [editingName, setEditingName] = useState<string | null>(null)

  if (isPending) {
    return <p className="text-slate-500 dark:text-slate-400">{t('playlistDetail.loading')}</p>
  }
  if (isError || !playlist) {
    return (
      <p role="alert" className="text-red-600 dark:text-red-400">
        {t('playlistDetail.loadError', {
          message: error?.message ?? t('playlistDetail.notFound'),
        })}
      </p>
    )
  }

  const songs = playlist.items.map((item) => item.song)
  const playlistContext = { kind: 'playlist', id: playlist.id, name: playlist.name } as const

  function playFrom(index: number) {
    const clickedSong = songs[index]
    if (currentSong?.id === clickedSong.id) {
      togglePlay()
      return
    }
    playFromContext(songs, index, playlistContext)
  }

  function move(item: PlaylistItem, direction: -1 | 1) {
    if (!playlist) return
    const order = playlist.items.map((entry) => entry.id)
    const from = order.indexOf(item.id)
    const to = from + direction
    if (to < 0 || to >= order.length) return
    ;[order[from], order[to]] = [order[to], order[from]]
    reorder.mutate({ playlistId: playlist.id, itemIds: order })
  }

  function submitRename(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = editingName?.trim()
    if (!playlist || !trimmed || trimmed === playlist.name) {
      setEditingName(null)
      return
    }
    rename.mutate({ id: playlist.id, name: trimmed }, { onSuccess: () => setEditingName(null) })
  }

  // Deleting removes the song from the library entirely, files included — the
  // same action as in the library, and distinct from removing it from this
  // playlist. The confirm copy is shared so the difference stays legible.
  async function handleDelete(song: Song) {
    const ok = await confirm({
      title: t('song.deleteTitle'),
      message: t('song.deleteMessage', { title: song.title }),
      confirmLabel: t('common.delete'),
      danger: true,
    })
    if (ok) deleteSong.mutate(song.id)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/playlists"
          className="text-sm text-accent-600 hover:underline dark:text-accent-400"
        >
          <span className="inline-flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" aria-hidden /> {t('playlistDetail.back')}
          </span>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {editingName === null ? (
          <>
            <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {playlist.name}
            </h2>
            <button
              type="button"
              onClick={() => setEditingName(playlist.name)}
              className="rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              {t('playlistDetail.rename')}
            </button>
          </>
        ) : (
          <form onSubmit={submitRename} className="flex gap-2">
            <input
              type="text"
              value={editingName}
              onChange={(event) => setEditingName(event.target.value)}
              aria-label={t('playlistDetail.nameAria')}
              autoFocus
              maxLength={300}
              className="rounded-lg border border-slate-300 px-3 py-1.5 outline-none focus:border-accent-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="submit"
              className="rounded-lg bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-700"
            >
              {t('common.save')}
            </button>
            <button
              type="button"
              onClick={() => setEditingName(null)}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              {t('common.cancel')}
            </button>
          </form>
        )}

        {songs.length > 0 && editingName === null && (
          <button
            type="button"
            onClick={() => playFromContext(songs, 0, playlistContext)}
            className="ml-auto rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-700"
          >
            <span className="inline-flex items-center gap-2">
              <Play className="h-4 w-4" aria-hidden /> {t('playlistDetail.playAll')}
            </span>
          </button>
        )}
      </div>

      {playlist.items.length === 0 ? (
        <p className="text-slate-500 dark:text-slate-400">
          <Trans
            i18nKey="playlistDetail.empty"
            components={{
              library: (
                <Link to="/" className="text-accent-600 hover:underline dark:text-accent-400" />
              ),
            }}
          />
        </p>
      ) : (
        <ul className="space-y-2">
          {playlist.items.map((item, index) => (
            <SongRow
              key={item.id}
              song={item.song}
              position={index + 1}
              onPlay={() => playFrom(index)}
              onAddToQueue={addToQueue}
              onPlayNext={playNext}
              onDelete={handleDelete}
              isDeleting={deleteSong.isPending && deleteSong.variables === item.song.id}
              isCurrent={currentSong?.id === item.song.id}
              isPlaying={isPlaying}
              actions={
                <>
                  <div className="flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={() => move(item, -1)}
                      disabled={index === 0 || reorder.isPending}
                      aria-label={t('playlistDetail.moveUpAria', { title: item.song.title })}
                      className="rounded p-1 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-700"
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(item, 1)}
                      disabled={index === playlist.items.length - 1 || reorder.isPending}
                      aria-label={t('playlistDetail.moveDownAria', { title: item.song.title })}
                      className="rounded p-1 text-slate-500 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-400 dark:hover:bg-slate-700"
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeItem.mutate({ playlistId: playlist.id, itemId: item.id })}
                    aria-label={t('playlistDetail.removeAria', { title: item.song.title })}
                    className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
                  >
                    {t('playlistDetail.remove')}
                  </button>
                </>
              }
            />
          ))}
        </ul>
      )}
    </div>
  )
}
