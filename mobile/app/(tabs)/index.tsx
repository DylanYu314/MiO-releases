import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native'

import { useLocalFavouriteIds, useSetLocalFavourite } from '../../src/api/localPlaylists'
import { useDownloadSong } from '../../src/api/localDownload'
import { useLocalSongs, type LibrarySort } from '../../src/api/localLibrary'
import { HintBanner, useHintDismissal } from '../../src/components/HintBanner'
import { PlaylistPicker } from '../../src/components/PlaylistPicker'
import { SelectionBar } from '../../src/components/SelectionBar'
import { SONG_ROW_HEIGHT, SongRow } from '../../src/components/SongRow'
import { useSelection } from '../../src/components/useSelection'
import { useDeleteLocalSongs } from '../../src/api/localDelete'
import { useSongActions } from '../../src/player/songActions'
import { usePlayer } from '../../src/player/store'
import { useScrollToPlaying } from '../../src/player/useScrollToPlaying'
import { isPlayable, type PlayableSong } from '../../src/api/types'
import { isFetching, useFetchingUrls } from '../../src/api/fetching'
import { useDeviceAdds } from '../../src/api/deviceAdds'
import { useTrackStates } from '../../src/api/trackStates'
import { useTheme, useThemedStyles, type Theme } from '../../src/theme'
import { useGuardedRouter } from '../../src/navigation/useGuardedRouter'
import { Button } from '../../src/components/ui/Button'
import { showToast } from '../../src/components/Toast'
import { Chip } from '../../src/components/ui/Chip'

const SORTS: { field: LibrarySort; labelKey: string }[] = [
  { field: 'added_at', labelKey: 'library.sort.recentlyAdded' },
  { field: 'title', labelKey: 'library.sort.titleAsc' },
  { field: 'artist', labelKey: 'library.sort.artistAsc' },
]

/**
 * The library. Phone-first: a search field, a row of sort chips, and an
 * infinite list — no table, no pagination controls, both of which assume a
 * width this screen does not have.
 */
export default function LibraryScreen() {
  const { t } = useTranslation()
  const router = useGuardedRouter()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<LibrarySort>('added_at')

  // The library is this device's now (#216, #246), so there is no paging and
  // no server round trip — the whole list is a local read, filtered in memory.
  const query = useMemo(() => ({ q: search.trim() || undefined, sort }), [search, sort])
  const { songs, isPending, isError, refetch } = useLocalSongs(query)
  const total = songs.length

  const currentId = usePlayer((state) => state.current?.song.id ?? null)
  const isPlaying = usePlayer((state) => state.isPlaying)

  /**
   * Choosing several tracks at once (#336).
   *
   * I asked for a **Select** button rather than a gesture, and that is also
   * the only option left: long-press already opens the sheet here and starts a
   * drag on a playlist.
   */
  const selection = useSelection()
  const deleteSongs = useDeleteLocalSongs()
  const [movingSelection, setMovingSelection] = useState(false)
  const [selectionBusy, setSelectionBusy] = useState(false)

  const songIds = useMemo(() => songs.map((song) => String(song.id)), [songs])
  useEffect(() => {
    // The list changes under the selection — a search is typed, a track is
    // deleted — and an id that no longer exists would keep being counted.
    selection.prune(songIds)
  }, [songIds, selection])

  const selectedSongs = useMemo(
    () => songs.filter((song) => selection.ids.has(String(song.id))),
    [songs, selection.ids],
  )

  const removeSelected = useCallback(() => {
    setSelectionBusy(true)
    void (async () => {
      try {
        /*
         * One call, one refresh (#569).
         *
         * This was a loop of `deleteSong.mutateAsync`, and every iteration
         * invalidated the library query — so the screen re-read SQLite and
         * rebuilt the whole list between each song. I could watch them go
         * one at a time, which is exactly what was happening.
         *
         * The batching inside `removeLocalSongs` matters too — it renumbers
         * each affected playlist once instead of once per song — but the
         * visible half was the refresh.
         */
        await deleteSongs.mutateAsync([...selection.ids])
        selection.end()
      } finally {
        setSelectionBusy(false)
      }
    })()
  }, [selection, deleteSongs])

  const { data: favouriteIds } = useLocalFavouriteIds()
  const toggleFavourite = useSetLocalFavourite()
  const onToggleFavourite = useCallback(
    // Favourites are local now (#219), so every song has one — including the
    // ones this device fetched itself, which could not be hearted at all.
    (song: PlayableSong, favourite: boolean) =>
      toggleFavourite.mutate({ songId: String(song.id), favourite }),
    [toggleFavourite],
  )

  // The handler needs the whole list to build the context queue, but must keep
  // a stable identity or SongRow's memo buys nothing and the list stutters on
  // every page fetch. A ref carries the list without entering the dep array.
  const songsRef = useRef(songs)
  useEffect(() => {
    songsRef.current = songs
  }, [songs])

  const downloadSong = useDownloadSong()
  /*
   * Who is fetching what, app-wide (#571). One subscription for the whole list
   * rather than a hook per row — this is a `FlatList` of hundreds.
   *
   * `useDownloadSong` goes through `importToDevice`, which records the add
   * itself, so nothing here has to set or clear anything: the state that used
   * to be kept by hand is now read from its owner.
   */
  const fetching = useFetchingUrls()
  /*
   * A value `extraData` can compare (#571).
   *
   * `fetching` is a `Set`, and its *size* is not enough: one track finishing as
   * another starts leaves the size unchanged while two rows need redrawing.
   * Bounded by how many downloads run at once — two — so sorting it is free.
   */
  const fetchingKey = useMemo(() => [...fetching].sort().join(','), [fetching])
  /**
   * The failure, **and which song it was about**.
   *
   * It was a bare string, set on failure and cleared only when another download
   * started — so a red line about a video YouTube will not serve stayed at the
   * top of the library indefinitely, including after the song it referred to had
   * been deleted. *"it just sticked there even if i remove the failed
   * track"*.
   *
   * Carrying the source url makes the message answerable by the list itself:
   * it is shown while that song is on screen and disappears with it, which is
   * the same self-invalidating shape the player's `resume` uses. No separate
   * "clear the error" path to forget to call.
   */
  const [downloadError, setDownloadError] = useState<{ url: string; message: string } | null>(null)

  // Derived during render rather than cleared from an effect: the list is the
  // authority on whether the song is still here, and reacting to it with a
  // `setState` is the pattern ESLint's react-hooks rules reject anyway.
  const visibleDownloadError =
    downloadError && songs.some((song) => song.source_url === downloadError.url)
      ? downloadError.message
      : null

  const playSong = useCallback(
    (song: PlayableSong) => {
      /**
       * A song with no audio anywhere cannot be played, so tapping it fetches it
       * (#268).
       *
       * A playlist import records every accepted track and then fetches the
       * audio, so a track it could not get leaves a row with no file. Playing
       * that would be silence, which reads as a broken app rather than a missing
       * download — and there is nowhere else for the user to go and get it.
       */
      if (!isPlayable(song)) {
        /*
         * Already on its way — from anywhere (#571).
         *
         * This used to consult `downloadingUrl`, a `useState` on this screen
         * set only when the user tapped a row *here*. A track being fetched by
         * a playlist import, an add-link or a search result read as "tap to
         * download", and tapping it started a **second concurrent download of
         * the same track**: `downloadAudioFromUrl` appends 2 MiB chunks to one
         * path, so two writers interleaving produce a file of plausible length
         * that does not play.
         */
        if (
          isFetching(song.source_url, useDeviceAdds.getState().adds, useTrackStates.getState().runs)
        ) {
          return
        }
        setDownloadError(null)
        downloadSong.mutate(song.source_url, {
          onError: (error) =>
            setDownloadError({
              url: song.source_url,
              message: error instanceof Error ? error.message : String(error),
            }),
        })
        return
      }

      const player = usePlayer.getState()
      // Tapping the playing row pauses rather than restarting from zero.
      if (player.current?.song.id === song.id) {
        player.togglePlay()
        return
      }
      const list = songsRef.current
      player.playFromContext(
        list,
        list.findIndex((candidate) => candidate.id === song.id),
        { kind: 'library' },
      )
    },
    [downloadSong],
  )

  const { open: openActions, sheets } = useSongActions()

  // Open on the playing track rather than the top of the library (#239).
  const songId = useCallback((song: PlayableSong) => song.id, [])
  /* Swipe right to queue (#316). A stable identity, or `SongRow`'s memo buys
   nothing and the whole list re-renders on every scroll. */
  // Retires the hint below the moment the gesture is used, which is what #502
  // asks for: the hint exists to cause a first swipe, so a first swipe is what
  // it should cost.
  const learnedSwipe = useHintDismissal('swipeToQueue')

  const enqueue = useCallback(
    (song: PlayableSong) => {
      usePlayer.getState().addToQueue(song)
      // Said out loud (#379). The swipe did the thing and mentioned nothing,
      // which on a gesture with no visible result is indistinguishable from a
      // gesture that missed — the queue is a screen away.
      showToast(t('queue.queuedToast', { title: song.title }))
      learnedSwipe()
    },
    [t, learnedSwipe],
  )
  const { listRef, getItemLayout } = useScrollToPlaying(
    songs,
    songId,
    currentId,
    SONG_ROW_HEIGHT + StyleSheet.hairlineWidth,
  )

  const empty = () => {
    if (isPending) return null
    if (isError) {
      return (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>{t('library.loadFailed')}</Text>
          <Button label={t('library.retry')} variant="plain" onPress={() => refetch()} />
        </View>
      )
    }
    if (search) {
      return (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>{t('library.noMatches', { query: search })}</Text>
        </View>
      )
    }
    /*
     * One empty state, not two.
     *
     * There used to be a separate "you need a key" screen shown whenever the
     * library was empty and no key was stored, on the reasoning that the two
     * almost always meant the same thing. Under P12 they did. **#170 made that
     * false** — a key gates searching and importing playlists, and has decided
     * nothing about *which* music you see since ownership moved to the install
     * id.
     *
     * So an empty library now says the library is empty, and offers the ways to
     * fill it. Adding a link comes first because it is the one path that needs
     * no key at all (ADR-009). The key is offered last, only when there is not
     * one, and described as what it actually unlocks — telling someone their
     * music is behind a key sends them hunting for a key when what they need is
     * to add a song.
     *
     * The Favourites link went with #226: an empty library has no favourites, so
     * it was the one destination here that could never help.
     */
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>{t('library.emptyShort')}</Text>
        <Text style={styles.emptyHint}>{t('library.needKeyHint')}</Text>
        <Button label={t('nav.addLink')} variant="plain" onPress={() => router.push('/add/link')} />
        <Button
          label={t('nav.search')}
          variant="plain"
          onPress={() => router.push('/add/search')}
        />
        <Button
          label={t('nav.import')}
          variant="plain"
          onPress={() => router.push('/add/import')}
        />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder={t('library.searchPlaceholder')}
          placeholderTextColor={theme.textMuted}
          accessibilityLabel={t('library.searchAria')}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        <View style={styles.chips}>
          {SORTS.map(({ field, labelKey }) => (
            <Chip
              key={field}
              label={t(labelKey)}
              selected={sort === field}
              onPress={() => setSort(field)}
            />
          ))}
        </View>
        <View style={styles.countRow}>
          {total > 0 ? (
            <Text style={styles.count}>{t('library.songCount', { count: total })}</Text>
          ) : null}
          {/* The affordance #336 turns on. Hidden while selecting, because the
              bar below already carries the way out. */}
          {total > 0 && !selection.active ? (
            <Button label={t('select.start')} variant="plain" onPress={selection.begin} />
          ) : null}
        </View>
        {/* Only while the song it is about is still in the list — see the note
            on `downloadError`. A message about a track the user has since
            deleted is a message about nothing. */}
        {visibleDownloadError ? (
          /*
           * Dismissible, which it was not (#430).
           *
           * It already self-invalidates when the song leaves the list, and that
           * instinct is right — but it is not enough on its own. I had one
           * sitting at the top of my library with no way to close it: the row
           * it referred to was still there, because the download had failed
           * against a track the library legitimately still knows about. A
           * message the user cannot get rid of is one they have to live with.
           */
          <View accessibilityRole="alert" style={styles.downloadErrorRow}>
            <Text style={[styles.downloadError, styles.downloadErrorText]}>
              {`${t('song.downloadFailed')} ${visibleDownloadError}`}
            </Text>
            <Button
              label={'×'}
              variant="plain"
              onPress={() => setDownloadError(null)}
              accessibilityLabel={t('common.dismiss')}
            />
          </View>
        ) : null}
      </View>

      {/* Only with something to swipe, and not while selecting — a tip about a
          gesture is noise on an empty library, and misleading in a mode where
          the row's press means something else (#336). */}
      {total > 0 && !selection.active ? (
        <HintBanner id="swipeToQueue" messageKey="library.swipeHint" />
      ) : null}

      {isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator />
          <Text style={styles.emptyHint}>{t('library.loading')}</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          getItemLayout={getItemLayout}
          data={songs}
          keyExtractor={(song) => String(song.id)}
          renderItem={({ item }) => (
            <SongRow
              song={item}
              onPress={selection.active ? (song) => selection.toggle(String(song.id)) : playSong}
              onOptions={openActions}
              selected={selection.stateFor(String(item.id))}
              isCurrent={item.id === currentId}
              isPlaying={isPlaying}
              isDownloading={fetching.has(item.source_url)}
              isFavourite={favouriteIds ? favouriteIds.has(String(item.id)) : undefined}
              onToggleFavourite={onToggleFavourite}
              onSwipeEnqueue={enqueue}
            />
          )}
          // The selection has to be in here, or a ticked row does not repaint:
          // `SongRow` is memoized and `FlatList` will not re-render a window
          // whose data has not changed identity.
          extraData={`${currentId}:${isPlaying}:${favouriteIds?.size ?? 0}:${fetchingKey}:${selection.active}:${selection.count}`}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={empty}
          contentContainerStyle={songs.length === 0 ? styles.flexGrow : undefined}
          // No paging: the whole library is one local read.
        />
      )}

      {selection.active ? (
        <SelectionBar
          count={selection.count}
          allSelected={total > 0 && selection.count === total}
          onToggleAll={() => selection.toggleAll(songIds)}
          onRemove={removeSelected}
          onMove={() => setMovingSelection(true)}
          // "Delete" here, "Remove" on a playlist. They are different acts —
          // one destroys the file, the other unfiles it — and wording them the
          // same is how someone loses a track they meant to unfile.
          removeLabel={t('select.delete')}
          onCancel={selection.end}
          busy={selectionBusy}
        />
      ) : null}

      {movingSelection ? (
        <PlaylistPicker
          songs={selectedSongs}
          onAdded={selection.end}
          onClose={() => setMovingSelection(false)}
        />
      ) : null}

      {/*
       * The row of five text links that used to sit here is gone (#226) — it is
       * exactly what the tab bar replaces, and leaving both would give every
       * destination two front doors that behave differently (a push onto the
       * library's stack versus a tab switch).
       *
       * #199 is still honoured, and better: importing a playlist was once
       * reachable only from the empty state, so it disappeared the moment the
       * library had a song in it. It is now two taps from anywhere.
       */}
      {sheets}
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    flexGrow: { flexGrow: 1 },
    header: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
    search: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 15,
      color: theme.text,
    },
    chips: { flexDirection: 'row', gap: 8 },
    downloadError: { fontSize: 12, color: theme.danger },
    // The message takes the room and the button keeps its own, so a long error
    // wraps under itself rather than squeezing the dismiss out of reach.
    downloadErrorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    downloadErrorText: { flex: 1 },

    count: { fontSize: 12, color: theme.textMuted },
    // The count and the Select link share a line: the header is already four
    // rows deep and a fifth for one link would push the list off the fold.
    countRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    selectLink: { fontSize: 13, color: theme.accentOnSurface, fontWeight: '600' },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: 16,
    },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 24 },
    emptyTitle: { fontSize: 16, fontWeight: '500', color: theme.text },
    emptyHint: { fontSize: 13, color: theme.textMuted, textAlign: 'center' },
  })
