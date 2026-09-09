import { useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import {
  useAddToLocalPlaylist,
  useDeleteLocalPlaylist,
  useLocalFavouriteIds,
  useLocalPlaylist,
  useLocalPlaylists,
  useRemoveFromLocalPlaylist,
  useRenameLocalPlaylist,
  useReorderLocalPlaylist,
  useSetLocalFavourite,
} from '../../../src/api/localPlaylists'
import { FAVOURITES } from '../../../src/library/playlists'
import { ActionSheet, type SheetAction } from '../../../src/components/ActionSheet'
import { DraggableList } from '../../../src/components/DraggableList'
import { PlaylistPicker } from '../../../src/components/PlaylistPicker'
import { SelectionBar } from '../../../src/components/SelectionBar'
import { NamePrompt } from '../../../src/components/NamePrompt'
import { SongPicker } from '../../../src/components/SongPicker'
import { SONG_ROW_HEIGHT, SongRow } from '../../../src/components/SongRow'
import { useSongActions } from '../../../src/player/songActions'
import { usePlayer } from '../../../src/player/store'
import { useScrollToPlaying } from '../../../src/player/useScrollToPlaying'
import type { PlayableSong } from '../../../src/api/types'
import type { LocalPlaylistItem } from '../../../src/library/playlists'
import { useTheme, useThemedStyles, type Theme } from '../../../src/theme'
import { useGuardedRouter } from '../../../src/navigation/useGuardedRouter'
import { Button } from '../../../src/components/ui/Button'
import { showToast } from '../../../src/components/Toast'

/** Every edit-mode row is this tall, which is what lets `DraggableList` do its
 *  maths as a division rather than a per-row measurement. */
const ROW_HEIGHT = 60

type Sort = 'position' | 'title' | 'artist'

/**
 * One playlist's songs (#236), with its settings panel (#237).
 *
 * Tapping a song plays that song, and makes the whole playlist the playback
 * context so it advances on its own. "Play" is the same thing from track one.
 *
 * The name is a heading in the body rather than the nav-bar title: a playlist
 * name is user-supplied and can be long, and a nav bar truncates hard.
 *
 * ## Two rendering paths, and why
 *
 * Browsing renders a `FlatList` — virtualized, so a few-hundred-track playlist
 * scrolls, and ready for #238's search and #239's scroll-to-playing.
 *
 * Editing renders a `DraggableList`, which draws every row eagerly because that
 * is what makes the drag maths exact (see its docblock). That cost is confined
 * to a mode the user opts into, rather than paid on every open.
 *
 * ## Sorting and reordering cannot both be true
 *
 * A sorted view is not the playlist's order, so a drop in one would write
 * positions that have nothing to do with what was dragged. Entering edit mode
 * therefore snaps back to playlist order, and the sort control is hidden while
 * editing — the alternative, a reorder that silently means something else, is
 * the kind of bug that corrupts data quietly.
 *
 * ## Favourites is one of these, not a screen of its own (#291)
 *
 * It used to have `playlists/favourites.tsx` to itself, which is why T5's
 * settings panel, edit mode, sort, search and open-on-playing all missed the
 * list people open most. The only thing that screen did which this one did not
 * was thread `SongRow`'s heart props — so this one threads them, for **every**
 * playlist rather than only favourites: un-hearting from any list is useful, and
 * a heart on some lists but not others is the harder rule to explain. What stays
 * special is what the store enforces (`isFavourites`: never renamed, never
 * deleted), plus a name and an empty state of its own.
 *
 * ## Tap and long-press do different things in edit mode
 *
 * Tap toggles the tick box; a long press starts a drag. They do not collide
 * because `DraggableList` only activates its pan after a delay, so a tap falls
 * through to the row underneath. This is deliberately *unlike* the queue panel,
 * which turns drag off while selecting — there, selection is the exceptional
 * mode and drag is the default; here both belong to the one edit mode the issue
 * asks for.
 */
export default function PlaylistDetailScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useGuardedRouter()

  // A local id: a minted string, not a number (#219).
  const playlistId = id
  const { data: playlistItems, isPending, isError, refetch } = useLocalPlaylist(playlistId ?? null)
  const { data: playlists } = useLocalPlaylists()
  const data = playlists?.find((playlist) => playlist.id === playlistId)

  const rename = useRenameLocalPlaylist()
  const remove = useDeleteLocalPlaylist()
  const reorder = useReorderLocalPlaylist()
  const removeItem = useRemoveFromLocalPlaylist()
  const addTracks = useAddToLocalPlaylist()
  const { data: favouriteIds } = useLocalFavouriteIds()
  const setFavourite = useSetLocalFavourite()

  const [renaming, setRenaming] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [sorting, setSorting] = useState(false)
  const [sort, setSort] = useState<Sort>('position')
  const [search, setSearch] = useState('')
  /** Item ids ticked in edit mode, or null when not editing. Ids rather than
   *  indices, because a removal renumbers every index after it and a selection
   *  that shifts under the user is worse than no selection. */
  const [selected, setSelected] = useState<readonly string[] | null>(null)
  /** Whether the playlist picker is open over the selection (#336). */
  const [movingSelection, setMovingSelection] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const editing = selected !== null

  /** Favourites has no name the user chose, and the backend refuses to rename or
   *  delete it. Reaching this screen with its id is possible by URL, so the
   *  guard is here rather than only at the entry points. */
  const isFavourites = data?.kind === FAVOURITES

  /** Favourites' stored name comes from the migration and is English, so it is
   *  the one playlist whose title is translated rather than shown as stored. */
  const name = isFavourites ? t('favourites.title') : (data?.name ?? '')

  const currentId = usePlayer((state) => state.current?.song.id ?? null)
  const isPlaying = usePlayer((state) => state.isPlaying)

  const items = useMemo(() => playlistItems ?? [], [playlistItems])

  /**
   * What is drawn. Searching and sorting are both views over the playlist, never
   * a rewrite of it — the stored order is only ever changed by an explicit drag.
   *
   * Filtered in memory for the same reason the library is (#238): a playlist is
   * tens or hundreds of rows read from local SQLite, so a query per keystroke
   * would be work for no gain.
   */
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const filtered = needle
      ? items.filter(
          ({ song }) =>
            song.title.toLowerCase().includes(needle) || song.artist.toLowerCase().includes(needle),
        )
      : items
    if (sort === 'position') return filtered
    return [...filtered].sort((a, b) =>
      sort === 'title'
        ? a.song.title.localeCompare(b.song.title)
        : a.song.artist.localeCompare(b.song.artist),
    )
  }, [items, sort, search])

  // Same stable-identity trick as the library: the handler needs the list, but
  // SongRow's memo needs the handler not to change.
  const songsRef = useRef<PlayableSong[]>([])
  useEffect(() => {
    songsRef.current = items.map((item) => item.song)
  }, [items])

  const context = useMemo(
    () => ({ kind: 'playlist' as const, id: playlistId, name }),
    [playlistId, name],
  )

  const playSong = useCallback(
    (song: PlayableSong) => {
      const player = usePlayer.getState()
      if (player.current?.song.id === song.id) {
        player.togglePlay()
        return
      }
      const list = songsRef.current
      player.playFromContext(
        list,
        list.findIndex((candidate) => candidate.id === song.id),
        context,
      )
    },
    [context],
  )

  const { open: openActions, sheets } = useSongActions()

  /**
   * The per-row heart (#291).
   *
   * On every playlist, not only favourites. Un-hearting drops the row *here*
   * once the refetch lands, because this screen's list is the favourites
   * playlist itself — everywhere else the heart just empties and the row stays,
   * which is the same thing the library screen does.
   */
  const onToggleFavourite = useCallback(
    (song: PlayableSong, favourite: boolean) =>
      setFavourite.mutate({ songId: String(song.id), favourite }),
    [setFavourite],
  )

  // Open on the playing track rather than the top (#239). Keyed on `visible`,
  // so it lands on the row as actually drawn.
  const itemSongId = useCallback((item: LocalPlaylistItem) => item.song.id, [])

  /**
   * Swipe right to queue, here as well as in the library (#402).
   *
   * `SongRow` has taken `onSwipeEnqueue` since #379 and this screen simply did
   * not pass it — which is the deliberate default: **absent means no gesture is
   * created at all**, so a list where queueing makes no sense does not quietly
   * grow one. Queueing from a playlist obviously does make sense.
   *
   * The edit-mode rows are not `SongRow`s at all — they are checkbox rows inside
   * `DraggableList` — so the drag and the swipe never meet on one row, and
   * ADR-018's composition question does not arise here. Read rather than
   * assumed, because the issue asked for it to be.
   *
   * Identical to the library's, toast included: the confirmation is the point on
   * a gesture whose result is a screen away (#379).
   */
  const enqueue = useCallback(
    (song: PlayableSong) => {
      usePlayer.getState().addToQueue(song)
      showToast(t('queue.queuedToast', { title: song.title }))
    },
    [t],
  )
  const { listRef, getItemLayout } = useScrollToPlaying(
    visible,
    itemSongId,
    currentId,
    SONG_ROW_HEIGHT + StyleSheet.hairlineWidth,
  )

  /**
   * Long-press a row here and the menu gains "remove from this playlist".
   *
   * A closure per row rather than one stable handler, which does cost `SongRow`'s
   * memo on this screen. That is the right trade here and only here: the menu
   * needs the **item** id, a song may sit in a playlist twice so the song id
   * cannot identify the row, and this list is neither paginated nor unbounded.
   */
  const openItemActions = (item: LocalPlaylistItem) =>
    openActions(item.song, [
      {
        key: 'remove-from-playlist',
        label: t('playlistDetail.removeFromPlaylist'),
        destructive: true,
        onPress: () => removeItem.mutate({ playlistId, itemIds: [item.id] }),
      },
    ])

  /** Reads `items` rather than `songsRef`, and is therefore not a `useCallback`.
   *  The ref exists purely to keep `playSong`'s identity stable for `SongRow`'s
   *  memo; nothing memoized takes this one, and reading a ref from a function
   *  the settings sheet calls during render is what `react-hooks/refs` forbids. */
  const playAll = () => {
    usePlayer.getState().playFromContext(
      items.map((item) => item.song),
      0,
      context,
    )
  }

  /**
   * Move one song, by sending the whole reordered id list.
   *
   * The store takes the complete order and rejects anything that is not exactly
   * the current ids, so a "move" has to be expressed as the resulting
   * arrangement. Computed from the cached order, which the optimistic update
   * keeps in step with what is on screen.
   */
  const move = (from: number, to: number) => {
    if (from === to) return
    const ids = items.map((item) => item.id)
    if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return
    const [moved] = ids.splice(from, 1)
    ids.splice(to, 0, moved)
    setNotice(null)
    reorder.mutate(
      { playlistId, itemIds: ids },
      { onError: () => setNotice(t('playlistDetail.reorderFailed')) },
    )
  }

  const toggleSelected = (itemId: string) =>
    setSelected((current) =>
      current === null
        ? [itemId]
        : current.includes(itemId)
          ? current.filter((id) => id !== itemId)
          : [...current, itemId],
    )

  const removeSelected = () => {
    if (!selected || selected.length === 0) return
    setNotice(null)
    removeItem.mutate(
      { playlistId, itemIds: [...selected] },
      { onError: () => setNotice(t('playlistDetail.removeFailed')) },
    )
    setSelected([])
  }

  const startEditing = () => {
    // Reordering a filtered or sorted view would write positions unrelated to
    // the drag, so editing always starts from the whole playlist in its own
    // order.
    setSort('position')
    setSearch('')
    setSelected([])
  }

  const addSongs = (songIds: string[]) => {
    setAdding(false)
    if (songIds.length === 0) return
    setNotice(null)
    addTracks.mutate(
      { playlistId, songIds },
      { onError: () => setNotice(t('playlistDetail.addFailed')) },
    )
  }

  const submitRename = (name: string) => {
    setNotice(null)
    rename.mutate(
      { playlistId, name },
      {
        onSuccess: () => setRenaming(false),
        onError: () => setNotice(t('playlistDetail.renameFailed')),
      },
    )
  }

  const confirmDelete = () => {
    Alert.alert(t('playlists.deleteTitle'), t('playlists.deleteMessage', { name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () =>
          remove.mutate(playlistId, {
            // Back to the list: staying on the detail screen of a playlist that
            // no longer exists would show a "couldn't load" error for something
            // the user just chose to do.
            onSuccess: () => router.back(),
            onError: () => setNotice(t('playlistDetail.deleteFailed')),
          }),
      },
    ])
  }

  /**
   * The settings panel (#237).
   *
   * The two queue actions are the interesting ones, and the reason this is a
   * panel rather than a second "play" button: they are how a playlist reaches
   * playback **without losing a hand-built user queue** (ADR-011). "Replace"
   * starts this list now; "append" adds it to the end of what is already
   * playing, and neither touches the user queue.
   */
  const settingsActions = (): SheetAction[] => {
    const actions: SheetAction[] = [
      {
        key: 'add-tracks',
        label: t('playlistDetail.addTracks'),
        replacesSheet: true,
        onPress: () => {
          setSettingsOpen(false)
          setAdding(true)
        },
      },
    ]

    if (items.length > 0) {
      actions.push(
        {
          key: 'edit',
          label: t('playlistDetail.edit'),
          onPress: startEditing,
        },
        {
          key: 'replace-queue',
          label: t('playlistDetail.replaceQueue'),
          onPress: playAll,
        },
        {
          key: 'append-queue',
          label: t('playlistDetail.appendQueue'),
          // Reads `items`, not `songsRef`: the ref exists to keep `playSong`'s
          // identity stable for SongRow's memo, and this sheet is rebuilt each
          // render anyway. Touching the ref here would also be a render-time ref
          // read, which `react-hooks/refs` rightly refuses.
          onPress: () =>
            usePlayer.getState().appendToContext(
              items.map((item) => item.song),
              context,
            ),
        },
      )
    }

    // Favourites is renamed and deleted by nobody — the store refuses both, so
    // offering them would be offering an error.
    if (!isFavourites) {
      actions.push(
        {
          key: 'rename',
          label: t('playlistDetail.rename'),
          replacesSheet: true,
          onPress: () => {
            setSettingsOpen(false)
            setNotice(null)
            setRenaming(true)
          },
        },
        {
          key: 'delete',
          label: t('common.delete'),
          destructive: true,
          onPress: confirmDelete,
        },
      )
    }

    return actions
  }

  if (isPending) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
        <Text style={styles.emptyHint}>{t('playlistDetail.loading')}</Text>
      </View>
    )
  }

  if (isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>{t('playlistDetail.loadFailed')}</Text>
        <Button label={t('library.retry')} variant="plain" onPress={() => refetch()} />
      </View>
    )
  }

  const header = (
    <View style={styles.heading}>
      <View style={styles.titleRow}>
        <Text style={styles.name}>{name}</Text>
        <Pressable
          onPress={() => setSettingsOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t('playlistDetail.settingsAria', { name })}
          hitSlop={10}
          style={({ pressed }) => [styles.dots, pressed && styles.pressed]}
        >
          <Text style={styles.dotsText}>{'⋯'}</Text>
        </Pressable>
      </View>
      <Text style={styles.count}>{t('playlists.songCount', { count: items.length })}</Text>

      <View style={styles.actions}>
        {items.length > 0 && !editing ? (
          <Pressable
            onPress={playAll}
            accessibilityRole="button"
            style={({ pressed }) => [styles.playAll, pressed && styles.pressed]}
            hitSlop={6}
          >
            <Text style={styles.playAllText}>{t('playlistDetail.playAll')}</Text>
          </Pressable>
        ) : null}

        {/* #336: selecting was reachable only as "Edit" inside the 3-dot sheet,
            which is the same discoverability problem the 3-dot itself was
            introduced to fix (#229). The library grew a Select button, so this
            gets the identical one — and it still opens the existing edit mode
            rather than a second mechanism. */}
        {items.length > 0 && !editing ? (
          <Button label={t('select.start')} variant="plain" onPress={startEditing} />
        ) : null}

        {editing ? null : items.length > 1 ? (
          <Button
            label={t(`playlistDetail.sort.${sort}`)}
            variant="plain"
            onPress={() => setSorting(true)}
            // The visible label is the *current* sort; the accessible name has
            // to say what pressing it does.
            accessibilityLabel={t('playlistDetail.sortAria')}
          />
        ) : null}
      </View>

      {/* Hidden while editing: a filtered list cannot be dragged meaningfully,
          and `startEditing` clears the query for the same reason. */}
      {!editing && items.length > 1 ? (
        <TextInput
          style={styles.search}
          value={search}
          onChangeText={setSearch}
          placeholder={t('playlistDetail.searchPlaceholder')}
          placeholderTextColor={theme.textMuted}
          accessibilityLabel={t('playlistDetail.searchAria')}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      ) : null}

      {editing ? <Text style={styles.hint}>{t('playlistDetail.editHint')}</Text> : null}

      {notice ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
    </View>
  )

  // "Nothing matches" and "nothing here" are different problems with different
  // fixes, and telling a searching user their playlist is empty is a lie.
  const empty = search.trim() ? (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{t('playlistDetail.noMatches', { query: search })}</Text>
    </View>
  ) : (
    // An empty favourites list is not an empty playlist: "add some tracks" is
    // the wrong instruction for a list you fill by tapping hearts elsewhere.
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>
        {t(isFavourites ? 'favourites.emptyTitle' : 'playlistDetail.emptyShort')}
      </Text>
      <Text style={styles.emptyHint}>
        {t(isFavourites ? 'favourites.emptyDescription' : 'playlistDetail.emptyHint')}
      </Text>
    </View>
  )

  return (
    <View style={styles.container}>
      {editing ? (
        // Edit mode draws every row, which is what the drag needs. See the
        // docblock: the cost is confined to a mode that is opted into.
        <FlatList
          data={[0]}
          keyExtractor={() => 'edit'}
          ListHeaderComponent={header}
          renderItem={() => (
            <DraggableList
              // `items`, not `visible`, and deliberately belt-and-braces:
              // `startEditing` already forces the sort back to playlist order,
              // so today these are the same list. Reading the raw one anyway
              // means editing cannot start drawing a sorted view if that reset
              // is ever lost — and a drag against a sorted list writes
              // positions unrelated to what moved.
              items={items}
              keyOf={(item) => item.id}
              rowHeight={ROW_HEIGHT}
              onReorder={move}
              renderItem={(item) => (
                <Pressable
                  onPress={() => toggleSelected(item.id)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected.includes(item.id) }}
                  accessibilityLabel={t(
                    selected.includes(item.id)
                      ? 'playlistDetail.deselectAria'
                      : 'playlistDetail.selectAria',
                    { title: item.song.title },
                  )}
                  style={({ pressed }) => [styles.editRow, pressed && styles.pressed]}
                >
                  <View style={[styles.checkbox, selected.includes(item.id) && styles.checkboxOn]}>
                    {selected.includes(item.id) ? <Text style={styles.checkmark}>✓</Text> : null}
                  </View>
                  <View style={styles.editText}>
                    <Text style={styles.editTitle} numberOfLines={1}>
                      {item.song.title}
                    </Text>
                    <Text style={styles.editArtist} numberOfLines={1}>
                      {item.song.artist}
                    </Text>
                  </View>
                </Pressable>
              )}
            />
          )}
        />
      ) : (
        <FlatList
          ref={listRef}
          getItemLayout={getItemLayout}
          data={visible}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <SongRow
              song={item.song}
              onPress={playSong}
              // A fresh closure per render, unlike the other two lists, because
              // "remove from playlist" needs this row's *item* id.
              onOptions={() => openItemActions(item)}
              isCurrent={item.song.id === currentId}
              isPlaying={isPlaying}
              isFavourite={favouriteIds ? favouriteIds.has(String(item.song.id)) : undefined}
              onToggleFavourite={onToggleFavourite}
              onSwipeEnqueue={enqueue}
            />
          )}
          extraData={`${currentId}:${isPlaying}:${sort}:${search}:${favouriteIds?.size ?? 0}`}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListHeaderComponent={header}
          ListEmptyComponent={empty}
        />
      )}

      {/*
       * The same bar as the library's (#336), and deliberately the same
       * component so the two modes look and read identically.
       *
       * The *state* is not shared, and that is not an oversight: this mode is
       * entangled with `DraggableList` — it forces the sort back to playlist
       * order, draws every row eagerly so a drag can measure them, and clears
       * the search — while the library's is a plain list. Rewriting this onto
       * `useSelection` would put #233's drag at risk to unify two things that
       * only look alike. What is shared is the presentation.
       */}
      {editing ? (
        <SelectionBar
          count={selected.length}
          allSelected={items.length > 0 && selected.length === items.length}
          onToggleAll={() =>
            setSelected((current) =>
              current && current.length === items.length ? [] : items.map((item) => item.id),
            )
          }
          onRemove={removeSelected}
          onMove={() => setMovingSelection(true)}
          // "Remove", not "Delete": this takes the track out of the playlist
          // and leaves it in the library. The library's bar says Delete,
          // because there it really is gone.
          removeLabel={t('select.remove')}
          onCancel={() => setSelected(null)}
        />
      ) : null}

      {movingSelection ? (
        <PlaylistPicker
          songs={items.filter((item) => selected?.includes(item.id)).map((item) => item.song)}
          onAdded={() => setSelected(null)}
          onClose={() => setMovingSelection(false)}
        />
      ) : null}

      {sheets}

      <ActionSheet
        visible={settingsOpen}
        title={name}
        subtitle={t('playlists.songCount', { count: items.length })}
        actions={settingsActions()}
        onClose={() => setSettingsOpen(false)}
      />

      <ActionSheet
        visible={sorting}
        title={t('playlistDetail.sortAria')}
        actions={(['position', 'title', 'artist'] as Sort[]).map((option) => ({
          key: option,
          label: t(`playlistDetail.sort.${option}`),
          onPress: () => setSort(option),
        }))}
        onClose={() => setSorting(false)}
      />

      {adding ? (
        <SongPicker
          title={t('playlistDetail.addTracks')}
          confirmLabel={(count) => t('playlistDetail.addCount', { count })}
          // Already-in rows are shown but not selectable, so adding a duplicate
          // is a decision rather than an accident.
          alreadyIn={new Set(items.map((item) => String(item.song.id)))}
          busy={addTracks.isPending}
          onConfirm={addSongs}
          onClose={() => setAdding(false)}
        />
      ) : null}

      {renaming ? (
        <NamePrompt
          title={t('playlistDetail.rename')}
          initialValue={data?.name ?? ''}
          confirmLabel={t('common.save')}
          busy={rename.isPending}
          onConfirm={submitRename}
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    heading: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6, gap: 2 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    name: { flex: 1, minWidth: 0, fontSize: 22, fontWeight: '600', color: theme.text },
    dots: { paddingHorizontal: 4 },
    dotsText: { fontSize: 22, color: theme.textMuted },
    playAll: {
      alignSelf: 'flex-start',
      marginTop: 10,
      paddingHorizontal: 18,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: theme.accentSolid,
    },
    playAllText: { color: theme.accentText, fontSize: 14, fontWeight: '600' },
    // Matches the library's Select link exactly — the two screens offer the
    // same affordance and should not look like different features (#336).
    selectLink: { fontSize: 13, color: theme.accentOnSurface, fontWeight: '600' },
    count: { fontSize: 12, color: theme.textMuted },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 18,
      marginTop: 10,
      flexWrap: 'wrap',
    },
    selectedCount: { fontSize: 12, color: theme.textMuted },
    destructive: { fontSize: 14, color: theme.danger },
    disabled: { opacity: 0.4 },
    error: { fontSize: 13, color: theme.danger, marginTop: 8 },
    hint: { fontSize: 12, color: theme.textMuted, marginTop: 8 },
    search: {
      marginTop: 10,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 9,
      fontSize: 15,
      color: theme.text,
    },
    editRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      gap: 12,
      height: ROW_HEIGHT,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 5,
      borderWidth: 2,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: theme.accentSolid, borderColor: theme.accentSolid },
    checkmark: { color: theme.accentText, fontSize: 13, fontWeight: '700' },
    editText: { flex: 1, minWidth: 0 },
    editTitle: { fontSize: 16, fontWeight: '500', color: theme.text },
    editArtist: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: 16,
    },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 24 },
    empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
    emptyTitle: { fontSize: 16, fontWeight: '500', color: theme.text },
    emptyHint: { fontSize: 13, color: theme.textMuted, textAlign: 'center' },
  })
