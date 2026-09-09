import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native'

import {
  useAddToLocalPlaylist,
  useCreateLocalPlaylist,
  useLocalPlaylistIdsForSong,
  useLocalPlaylists,
} from '../api/localPlaylists'
import type { PlayableSong } from '../api/types'
import { useThemedStyles, type Theme } from '../theme'
import { NamePrompt } from './NamePrompt'
import { Button } from '../components/ui/Button'

interface Props {
  /**
   * The songs to file. One from the 3-dot sheet; several from selection mode
   * (#336).
   *
   * An array in both cases rather than a `song | songs` union: every branch
   * below would otherwise have to normalise it, and the single-song caller
   * writing `[song]` is a smaller cost than that.
   */
  songs: readonly PlayableSong[]
  onClose: () => void
  /** Called once something was actually added, so a caller in selection mode can
   *  leave the mode rather than making the user dismiss twice. */
  onAdded?: () => void
}

/**
 * Choose which playlist a song goes into.
 *
 * ## It stays open after adding
 *
 * Closing on success would be the obvious thing and is worse: adding one song to
 * two or three playlists is a normal thing to want, and a picker that closes
 * makes that three long-presses instead of three taps. So each row reports
 * "Added" and the sheet waits to be dismissed.
 *
 * That also solves the feedback problem without a toast. There is no toast
 * component in this app, and `ToastAndroid` would be invisible behind an open
 * modal anyway — the confirmation has to live inside the sheet.
 *
 * Duplicates are the backend's business, not this component's: an ordinary
 * playlist may hold the same song twice. Rows already added are disabled so it
 * does not happen by accident, but nothing here rejects it.
 */
export function PlaylistPicker({ songs, onClose, onAdded }: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const { data, isPending, isError, refetch } = useLocalPlaylists()
  const addItem = useAddToLocalPlaylist()
  const createPlaylist = useCreateLocalPlaylist()
  /*
   * Which playlists already hold this song (#231). Before this the picker only
   * knew what *this session* had added, so a song added last week looked
   * addable and the duplicate was discovered afterwards.
   *
   * Only asked for a single song. With several, "already in it" is not a
   * property of the selection — some are and some are not — and disabling the
   * row would refuse an add that would legitimately place the others.
   * `addSongsToPlaylist` skips the ones already there, so nothing is lost.
   */
  const single = songs.length === 1 ? songs[0] : null
  const { data: alreadyIn } = useLocalPlaylistIdsForSong(single ? String(single.id) : null)

  const [naming, setNaming] = useState(false)
  /** Playlists this song has been added to while the picker was open. Local
   *  rather than derived: the response says the playlist changed, and reading
   *  membership back would mean fetching every playlist's items. */
  const [added, setAdded] = useState<readonly string[]>([])
  const [failed, setFailed] = useState<string | null>(null)

  // Favourites has its own screen and its own button; adding to it from here
  // would be a second way to do the same thing.
  const playlists = (data ?? []).filter((playlist) => playlist.kind !== 'favourites')

  const close = () => {
    setAdded([])
    setFailed(null)
    onClose()
  }

  const add = async (playlistId: string) => {
    setFailed(null)
    try {
      await addItem.mutateAsync({
        playlistId,
        songIds: songs.map((entry) => String(entry.id)),
      })
      setAdded((current) => [...current, playlistId])
      onAdded?.()
    } catch {
      setFailed(t('playlists.addFailed'))
    }
  }

  /** Create, then add straight away — nobody makes a playlist from this screen
   *  for any other reason. */
  const createAndAdd = async (name: string) => {
    setFailed(null)
    try {
      const playlistId = await createPlaylist.mutateAsync(name)
      setNaming(false)
      await add(playlistId)
    } catch (error) {
      setFailed(
        `${t('playlists.createFailed')} ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <Pressable
        style={({ pressed }) => [styles.backdrop, pressed && styles.pressed]}
        onPress={close}
        accessibilityRole="button"
      />
      <View style={styles.sheet}>
        <Text style={styles.title}>{t('playlists.addTo')}</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {single ? single.title : t('select.count', { count: songs.length })}
        </Text>

        <Pressable
          onPress={() => setNaming(true)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}
        >
          <Text style={styles.newText}>{t('playlists.newPlaylist')}</Text>
        </Pressable>

        {failed ? <Text style={styles.error}>{failed}</Text> : null}

        {isPending ? (
          <ActivityIndicator style={styles.loading} />
        ) : isError ? (
          <View style={styles.message}>
            <Text style={styles.messageText}>{t('playlists.loadFailed')}</Text>
            <Button label={t('library.retry')} variant="plain" onPress={() => refetch()} />
          </View>
        ) : playlists.length === 0 ? (
          <View style={styles.message}>
            <Text style={styles.messageText}>{t('playlists.emptyShort')}</Text>
          </View>
        ) : (
          <FlatList
            data={playlists}
            keyExtractor={(playlist) => String(playlist.id)}
            style={styles.list}
            // No paging: a local read of a short list.
            renderItem={({ item }) => {
              // "Already in it" and "just added it" render the same, because to
              // the person looking at the row they mean the same thing.
              const done = added.includes(item.id) || (alreadyIn?.has(item.id) ?? false)
              return (
                <Pressable
                  onPress={() => void add(item.id)}
                  disabled={done}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: done }}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  <Text style={styles.rowName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={done ? styles.done : styles.count}>
                    {done
                      ? t('playlists.added')
                      : t('playlists.songCount', { count: item.item_count })}
                  </Text>
                </Pressable>
              )
            }}
          />
        )}

        <Pressable
          onPress={close}
          accessibilityRole="button"
          style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}
        >
          <Text style={styles.doneText}>{t('common.done')}</Text>
        </Pressable>
      </View>

      {naming ? (
        <NamePrompt
          title={t('playlists.newPlaylist')}
          confirmLabel={t('playlists.create')}
          busy={createPlaylist.isPending}
          onConfirm={(name) => void createAndAdd(name)}
          onClose={() => setNaming(false)}
        />
      ) : null}
    </Modal>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)' },
    sheet: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingTop: 18,
      paddingBottom: 20,
      maxHeight: '75%',
    },
    title: { fontSize: 16, fontWeight: '700', paddingHorizontal: 20, color: theme.text },
    subtitle: { fontSize: 13, color: theme.textMuted, paddingHorizontal: 20, marginTop: 2 },
    newRow: { paddingHorizontal: 20, paddingVertical: 14, marginTop: 6 },
    newText: { fontSize: 16, color: theme.accentOnSurface, fontWeight: '600' },
    list: { flexGrow: 0 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 13,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    rowName: { flex: 1, minWidth: 0, fontSize: 16, color: theme.text },
    count: { fontSize: 13, color: theme.textMuted },
    done: { fontSize: 13, color: theme.accentOnSurface, fontWeight: '600' },
    error: { fontSize: 13, color: theme.danger, paddingHorizontal: 20, paddingBottom: 4 },
    loading: { paddingVertical: 24 },
    message: { padding: 20, gap: 6 },
    messageText: { fontSize: 14, color: theme.textMuted },
    doneButton: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingVertical: 14,
      alignItems: 'center',
      marginTop: 6,
    },
    doneText: { fontSize: 16, color: theme.accentOnSurface, fontWeight: '600' },
  })
