import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useDeleteSong, useSongs } from '../api/songs'
import type { Song, SongSortField, SortOrder } from '../api/types'
import { Pagination } from '../components/Pagination'
import { SongRow } from '../components/SongRow'
import { useDebounced } from '../lib/useDebounced'
import { selectCurrentSong, usePlayerStore } from '../player/store'
import { useConfirm } from '../components/ui/confirm/context'

const PAGE_SIZE = 20

// Labels are translated at render, so the option list itself stays a constant.
const SORT_OPTIONS: { value: `${SongSortField}:${SortOrder}`; labelKey: string }[] = [
  { value: 'added_at:desc', labelKey: 'library.sort.recentlyAdded' },
  { value: 'added_at:asc', labelKey: 'library.sort.oldestFirst' },
  { value: 'title:asc', labelKey: 'library.sort.titleAsc' },
  { value: 'artist:asc', labelKey: 'library.sort.artistAsc' },
  { value: 'duration:desc', labelKey: 'library.sort.longestFirst' },
]

export function LibraryPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [sortValue, setSortValue] =
    useState<(typeof SORT_OPTIONS)[number]['value']>('added_at:desc')
  const [offset, setOffset] = useState(0)

  // Wait for a pause in typing so we aren't firing a request per keystroke.
  const debouncedSearch = useDebounced(search, 300)
  const [sort, order] = sortValue.split(':') as [SongSortField, SortOrder]

  // Changing the search or sort invalidates the current page, so reset it in the
  // handlers rather than in an effect reacting to them — an effect that calls
  // setState causes a second render pass for no reason.
  function handleSearchChange(value: string) {
    setSearch(value)
    setOffset(0)
  }

  function handleSortChange(value: typeof sortValue) {
    setSortValue(value)
    setOffset(0)
  }

  const { data, isPending, isError, error } = useSongs({
    q: debouncedSearch || undefined,
    sort,
    order,
    limit: PAGE_SIZE,
    offset,
  })
  const deleteSong = useDeleteSong()
  const confirm = useConfirm()

  const currentSong = usePlayerStore(selectCurrentSong)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const playFromContext = usePlayerStore((state) => state.playFromContext)
  const togglePlay = usePlayerStore((state) => state.togglePlay)
  const addToQueue = usePlayerStore((state) => state.addToQueue)
  const playNext = usePlayerStore((state) => state.playNext)

  function handlePlay(song: Song) {
    // Clicking the song already playing toggles it rather than restarting.
    if (currentSong?.id === song.id) {
      togglePlay()
      return
    }
    // Play the visible page from this song, so "next" continues down the list
    // instead of stopping after one track.
    const songs = data?.items ?? [song]
    playFromContext(
      songs,
      songs.findIndex((item) => item.id === song.id),
      { kind: 'library' },
    )
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder={t('library.searchPlaceholder')}
          aria-label={t('library.searchAria')}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:ring-accent-900"
        />
        <select
          value={sortValue}
          onChange={(event) => handleSortChange(event.target.value as typeof sortValue)}
          aria-label={t('library.sortAria')}
          className="rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-accent-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
      </div>

      {isPending && <p className="text-slate-500 dark:text-slate-400">{t('library.loading')}</p>}

      {isError && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {t('library.loadError', { message: error.message })}
        </p>
      )}

      {data && data.items.length === 0 && (
        <p className="text-slate-500 dark:text-slate-400">
          {debouncedSearch
            ? t('library.noMatches', { query: debouncedSearch })
            : t('library.empty')}
        </p>
      )}

      {data && data.items.length > 0 && (
        <>
          <ul className="space-y-2">
            {data.items.map((song) => (
              <SongRow
                key={song.id}
                song={song}
                onPlay={handlePlay}
                onAddToQueue={addToQueue}
                onPlayNext={playNext}
                onDelete={handleDelete}
                isDeleting={deleteSong.isPending && deleteSong.variables === song.id}
                isCurrent={currentSong?.id === song.id}
                isPlaying={isPlaying}
              />
            ))}
          </ul>
          <Pagination
            total={data.total}
            limit={data.limit}
            offset={data.offset}
            onOffsetChange={setOffset}
          />
        </>
      )}
    </div>
  )
}
