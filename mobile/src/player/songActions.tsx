import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from 'react-native'

import { useDeleteLocalSong } from '../api/localDelete'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { PlaylistPicker } from '../components/PlaylistPicker'
import type { PlayableSong } from '../api/types'
import { usePlayer } from './store'

/**
 * The long-press menu for a song row, and the modals it can open.
 *
 * ## Why this replaced `showQueueActions`
 *
 * That was an imperative `Alert.alert` call, which was the right size for three
 * actions and cannot hold a fourth: React Native's Android `Alert` does
 * `buttons.slice(0, 3)`, so "add to playlist" would have been **dropped without
 * an error**. See `ActionSheet`.
 *
 * A hook rather than a function because a sheet is a component with state, and
 * the three screens that raise this menu should not each grow the same three
 * pieces of modal bookkeeping.
 *
 * Extra actions are passed **at open time** rather than configured once. The
 * playlist screen's "remove from playlist" needs the playlist *item* id — a song
 * can sit in a playlist twice, so the song id does not identify the row to
 * remove — and only the row being pressed knows it.
 */
export function useSongActions() {
  const { t } = useTranslation()
  const [song, setSong] = useState<PlayableSong | null>(null)
  const [extra, setExtra] = useState<readonly SheetAction[]>([])
  const [pickerSong, setPickerSong] = useState<PlayableSong | null>(null)
  const deleteSong = useDeleteLocalSong()

  const open = useCallback((next: PlayableSong, extraActions: readonly SheetAction[] = []) => {
    setSong(next)
    setExtra(extraActions)
  }, [])

  const close = useCallback(() => {
    setSong(null)
    setExtra([])
  }, [])

  const actions: readonly SheetAction[] = song
    ? [
        {
          key: 'play-next',
          label: t('song.playNext'),
          onPress: () => usePlayer.getState().playNext(song),
        },
        {
          key: 'queue',
          label: t('song.queue'),
          onPress: () => usePlayer.getState().addToQueue(song),
        },
        {
          key: 'add-to-playlist',
          label: t('song.addToPlaylist'),
          onPress: () => setPickerSong(song),
        },
        ...extra,
        {
          key: 'delete',
          label: t('song.delete'),
          destructive: true,
          // Confirmed, and the message says the file goes too — this removes
          // the audio from the device, not just the row, and there is no undo.
          // Two buttons, so `Alert` is under Android's three-button ceiling
          // (see ActionSheet for why that ceiling matters).
          onPress: () =>
            Alert.alert(t('song.deleteTitle'), t('song.deleteMessage', { title: song.title }), [
              { text: t('common.cancel'), style: 'cancel' },
              {
                text: t('common.delete'),
                style: 'destructive',
                onPress: () => deleteSong.mutate(song.id),
              },
            ]),
        },
      ]
    : []

  const sheets = (
    <>
      <ActionSheet
        visible={song !== null}
        title={song?.title ?? ''}
        subtitle={song?.artist}
        artworkUri={song?.cover_uri}
        actions={actions}
        onClose={close}
      />
      {/* Mounted only while open. Rendered unconditionally it would call
          `useLocalPlaylists()` on every screen that raises this menu, reading
          the playlist table on mount whether or not anyone ever long-presses. */}
      {pickerSong ? (
        <PlaylistPicker songs={[pickerSong]} onClose={() => setPickerSong(null)} />
      ) : null}
    </>
  )

  return { open, sheets }
}
