import { Heart } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useFavourites, useRemovePlaylistItem } from '../api/playlists'
import { useDeleteSong } from '../api/songs'
import type { Song } from '../api/types'
import { SongRow } from '../components/SongRow'
import { Button, EmptyState } from '../components/ui'
import { useConfirm } from '../components/ui/confirm/context'
import { selectCurrentSong, usePlayerStore } from '../player/store'

/**
 * The favourites playlist. It is an ordinary playlist row (ADR-011's sibling
 * decision: a real playlist, not a flag on Song), so it plays and reorders like
 * any other — it just can't be renamed or deleted, and gains rows via the heart.
 */
export function FavouritesPage() {
  const { t } = useTranslation()
  const { data: favourites, isPending, isError, error } = useFavourites()
  const removeItem = useRemovePlaylistItem()
  const deleteSong = useDeleteSong()
  const confirm = useConfirm()

  const currentSong = usePlayerStore(selectCurrentSong)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const playFromContext = usePlayerStore((state) => state.playFromContext)
  const togglePlay = usePlayerStore((state) => state.togglePlay)
  const addToQueue = usePlayerStore((state) => state.addToQueue)
  const playNext = usePlayerStore((state) => state.playNext)

  if (isPending) {
    return <p className="text-slate-500 dark:text-slate-400">{t('favourites.loading')}</p>
  }
  if (isError || !favourites) {
    return (
      <p role="alert" className="text-red-600 dark:text-red-400">
        {t('favourites.loadError', { message: error?.message ?? '' })}
      </p>
    )
  }

  const songs = favourites.items.map((item) => item.song)
  const context = { kind: 'playlist', id: favourites.id, name: t('favourites.title') } as const

  function playFrom(index: number) {
    if (currentSong?.id === songs[index].id) {
      togglePlay()
      return
    }
    playFromContext(songs, index, context)
  }

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
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="inline-flex items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
          <Heart className="h-6 w-6 text-red-500" aria-hidden fill="currentColor" />
          {t('favourites.title')}
        </h2>
        {songs.length > 0 && (
          <Button className="ml-auto" onClick={() => playFromContext(songs, 0, context)}>
            {t('playlistDetail.playAll')}
          </Button>
        )}
      </div>

      {songs.length === 0 ? (
        <EmptyState
          icon={<Heart className="h-8 w-8" aria-hidden />}
          title={t('favourites.emptyTitle')}
          description={t('favourites.emptyDescription')}
        />
      ) : (
        <ul className="space-y-2">
          {favourites.items.map((item, index) => (
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
                <button
                  type="button"
                  onClick={() => removeItem.mutate({ playlistId: favourites.id, itemId: item.id })}
                  aria-label={t('playlistDetail.removeAria', { title: item.song.title })}
                  className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
                >
                  {t('playlistDetail.remove')}
                </button>
              }
            />
          ))}
        </ul>
      )}
    </div>
  )
}
