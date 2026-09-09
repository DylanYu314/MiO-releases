import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'

import { FAVOURITES, type LocalPlaylist } from '../../../src/library/playlists'
import {
  useAddToLocalPlaylist,
  useCreateLocalPlaylist,
  useDeleteLocalPlaylists,
  useLocalPlaylists,
} from '../../../src/api/localPlaylists'
import { NamePrompt } from '../../../src/components/NamePrompt'
import { PlaylistRow } from '../../../src/components/PlaylistRow'
import { SelectionBar } from '../../../src/components/SelectionBar'
import { useSelection } from '../../../src/components/useSelection'
import { SongPicker } from '../../../src/components/SongPicker'
import { useThemedStyles, type Theme } from '../../../src/theme'
import { useGuardedRouter } from '../../../src/navigation/useGuardedRouter'
import { Button } from '../../../src/components/ui/Button'

/**
 * The playlist list.
 *
 * P6 shipped this read-only, on the reasoning that a phone's job is to play what
 * is already there. That was wrong in one direction: making a playlist while
 * listening is exactly a phone thing, and until #175 there was no way to do it
 * anywhere but the web client. Creating is here now; renaming, deleting and
 * reordering are slice B of that issue.
 *
 * **Favourites is pinned at the top rather than listed.** It comes back from
 * the device's own playlist table like any other row, and this screen filters
 * it out of the ordinary list — which
 * is right for the ordinary list (it has no name the user chose, and it cannot be
 * renamed or deleted) but wrong as the whole story: filtered *and* not shown
 * anywhere on this screen, it simply looked missing. Pinned, it is findable from
 * the place people look for it, without pretending to be an ordinary playlist.
 *
 * The row is pinned; the **screen** behind it is the ordinary one (#291). It
 * needs favourites' real id for that, which is why the filtered-out row is kept
 * rather than discarded — and why the count comes from it instead of a second
 * query for the hearted ids.
 */
export default function PlaylistsScreen() {
  const { t } = useTranslation()
  const router = useGuardedRouter()
  const styles = useThemedStyles(makeStyles)

  // Local, and therefore unpaged: a phone's playlists are a short list read
  // straight from SQLite (#219).
  const { data, isPending, isError, refetch } = useLocalPlaylists()
  const createPlaylist = useCreateLocalPlaylist()
  const addTracks = useAddToLocalPlaylist()

  const [naming, setNaming] = useState(false)
  /** The name, held between the two steps of creation. Non-null means the name
   *  is settled and the track picker is open — it is the step marker as well as
   *  the value, so the two cannot disagree. */
  const [pendingName, setPendingName] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  // Favourites is pinned first by the query itself, so it is filtered out
  // here and shown as its own row above the rest.
  const playlists = useMemo(() => (data ?? []).filter((p) => p.kind !== FAVOURITES), [data])
  /** The pinned row needs the real id, because since #291 it opens the shared
   *  playlist screen like every other row rather than a screen of its own. */
  const favourites = (data ?? []).find((p) => p.kind === FAVOURITES)

  /**
   * Step one of two: take the name, then open the track picker (#235).
   *
   * Nothing is written yet. Creating on the name alone and adding tracks
   * afterwards would leave a stray empty playlist behind every time someone
   * backed out of the picker, and "cancel" has to mean nothing happened.
   */
  const nameSettled = (name: string) => {
    setCreateError(null)
    setNaming(false)
    setPendingName(name)
  }

  /**
   * Step two: create the playlist and fill it, in that order.
   *
   * `songIds` may be empty — leaving a playlist empty is a supported outcome,
   * not a cancelled one, which is why the picker allows confirming with nothing
   * selected.
   */
  const create = async (name: string, songIds: string[]) => {
    setCreateError(null)
    let playlistId: string
    try {
      playlistId = await createPlaylist.mutateAsync(name)
    } catch (error) {
      // The reason, not just "it failed". A generic message turns a bug report
      // into a guessing game — which is exactly what it cost when creating a
      // playlist stopped working and the only signal was this string.
      setCreateError(
        `${t('playlists.createFailed')} ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    if (songIds.length > 0) {
      try {
        await addTracks.mutateAsync({ playlistId, songIds })
      } catch {
        // The playlist exists at this point, so this is not a failed creation.
        // Say which half went wrong and still open it — the songs can be added
        // again from inside, and pretending nothing was made would be a lie.
        setCreateError(t('playlists.addTracksFailed'))
      }
    }

    setPendingName(null)
    // Straight into the new playlist, so the result is visible — landing back on
    // an unchanged-looking list gives no clue anything happened.
    router.push(`/playlists/${playlistId}`)
  }

  // Stable identity, or PlaylistRow's memo buys nothing.
  const open = useCallback(
    (playlist: LocalPlaylist) => router.push(`/playlists/${playlist.id}`),
    [router],
  )

  /*
   * Choosing several playlists at once (#570).
   *
   * *"I want to select multiple playlist at once, to delete, in case if
   * I have too many playlist"*.
   *
   * The same `useSelection` + `SelectionBar` the library uses (#336), and
   * started by an explicit **Select** button — never a long press. That was
   * settled by #336 and it still holds: a long press already means "open the
   * sheet" on a song and "start dragging" inside a playlist, and a third
   * meaning for one gesture is a conflict rather than a shortcut.
   *
   * ⚠️ **Favourites is not in this list.** It is drawn in the list's header, so
   * it cannot be ticked — which is the right place for the protection, because
   * a row that can be selected and then refuses to be deleted is a worse
   * experience than one that was never offered. `deletePlaylists` throws for it
   * anyway, as a check on this reasoning rather than as the user's guard rail.
   */
  const selection = useSelection()
  const [selectionBusy, setSelectionBusy] = useState(false)
  const deletePlaylists = useDeleteLocalPlaylists()

  const playlistIds = useMemo(() => playlists.map((playlist) => String(playlist.id)), [playlists])
  /*
   * ⚠️ No `prune` effect here, unlike the library screen — deliberately.
   *
   * The library's is reachable: typing in its search box shrinks the list under
   * a live selection, so an id that is no longer shown would keep being
   * counted. This screen has no filter, and deleting ends selection mode, so
   * nothing can remove a row from under a tick. A mutation confirmed it: taking
   * the effect out changed no test, because there is no way to reach it.
   *
   * Left out rather than kept as insurance. A guard no test can fail is the
   * same thing #569 deleted from `removeSongsFromAllPlaylists`; when a filter
   * arrives here it can come back with a test that means something.
   */

  const deleteSelected = useCallback(() => {
    setSelectionBusy(true)
    void (async () => {
      try {
        await deletePlaylists.mutateAsync([...selection.ids])
        selection.end()
      } finally {
        setSelectionBusy(false)
      }
    })()
  }, [selection, deletePlaylists])

  const onRowPress = selection.active
    ? (playlist: LocalPlaylist) => selection.toggle(String(playlist.id))
    : open

  const empty = () => {
    if (isPending) return null
    if (isError) {
      return (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>{t('playlists.loadFailed')}</Text>
          <Button label={t('library.retry')} variant="plain" onPress={() => refetch()} />
        </View>
      )
    }
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyTitle}>{t('playlists.emptyShort')}</Text>
        <Text style={styles.emptyHint}>{t('playlists.emptyHint')}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {/* Outside the list rather than in its header, so it is reachable while
          the list is still loading and on the empty state — which is exactly
          when someone wants it. */}
      <View style={styles.actions}>
        <Pressable
          onPress={() => {
            setCreateError(null)
            setNaming(true)
          }}
          accessibilityRole="button"
          style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}
        >
          <Text style={styles.newButtonText}>{t('playlists.newPlaylist')}</Text>
        </Pressable>
        {playlists.length > 0 && !selection.active ? (
          <Button label={t('select.start')} variant="plain" onPress={selection.begin} />
        ) : null}
      </View>
      {createError ? <Text style={styles.error}>{createError}</Text> : null}

      {isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator />
          <Text style={styles.emptyHint}>{t('playlists.loading')}</Text>
        </View>
      ) : (
        <FlatList
          data={playlists}
          keyExtractor={(playlist) => String(playlist.id)}
          renderItem={({ item }) => (
            <PlaylistRow
              playlist={item}
              onPress={onRowPress}
              selected={selection.stateFor(String(item.id))}
            />
          )}
          extraData={`${selection.active}:${selection.count}`}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListHeaderComponent={
            <>
              <Pressable
                onPress={() => favourites && router.push(`/playlists/${favourites.id}`)}
                disabled={!favourites}
                accessibilityRole="button"
                style={({ pressed }) => [styles.favouritesRow, pressed && styles.pressed]}
              >
                <Text style={styles.heart}>{'\u2665'}</Text>
                <View style={styles.favouritesText}>
                  <Text style={styles.favouritesTitle}>{t('favourites.title')}</Text>
                  <Text style={styles.favouritesCount}>
                    {t('playlists.songCount', { count: favourites?.item_count ?? 0 })}
                  </Text>
                </View>
              </Pressable>
              <View style={styles.separator} />
            </>
          }
          ListEmptyComponent={empty}
          contentContainerStyle={playlists.length === 0 ? styles.flexGrow : undefined}
          // No paging: a phone's playlists are a short local read.
        />
      )}

      {selection.active ? (
        <SelectionBar
          count={selection.count}
          allSelected={selection.count > 0 && selection.count === playlists.length}
          onToggleAll={() => selection.toggleAll(playlistIds)}
          // "Delete", not "Remove": a playlist really is gone. The songs are
          // not, which is the distinction the copy has to carry.
          removeLabel={t('common.delete')}
          onRemove={deleteSelected}
          onCancel={selection.end}
          busy={selectionBusy}
        />
      ) : null}

      {naming ? (
        <NamePrompt
          title={t('playlists.newPlaylist')}
          confirmLabel={t('common.done')}
          busy={false}
          onConfirm={nameSettled}
          onClose={() => setNaming(false)}
        />
      ) : null}

      {pendingName !== null ? (
        <SongPicker
          title={t('playlists.pickTracks', { name: pendingName })}
          // Empty is a real choice here, so the button says what will happen
          // rather than going disabled and leaving no way forward.
          allowEmpty
          confirmLabel={(count) =>
            count === 0 ? t('playlists.createEmpty') : t('playlists.createWithCount', { count })
          }
          busy={createPlaylist.isPending || addTracks.isPending}
          onConfirm={(songIds) => void create(pendingName, songIds)}
          onClose={() => setPendingName(null)}
        />
      ) : null}
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background },
    flexGrow: { flexGrow: 1 },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: 16,
    },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, padding: 24 },
    emptyTitle: { fontSize: 16, fontWeight: '500', color: theme.text },
    emptyHint: { fontSize: 13, color: theme.textMuted, textAlign: 'center' },
    footer: { paddingVertical: 16 },
    actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    newButton: { paddingHorizontal: 16, paddingVertical: 14 },
    newButtonText: { fontSize: 16, color: theme.accentOnSurface, fontWeight: '600' },
    error: { fontSize: 13, color: theme.danger, paddingHorizontal: 16, paddingBottom: 8 },
    favouritesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      gap: 14,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    heart: { fontSize: 22, color: theme.accentOnSurface },
    favouritesText: { flex: 1, minWidth: 0 },
    favouritesTitle: { fontSize: 16, fontWeight: '600', color: theme.text },
    favouritesCount: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
  })
