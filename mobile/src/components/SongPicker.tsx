import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { useLocalPlaylist, useLocalPlaylists } from '../api/localPlaylists'
import { useLocalSongs } from '../api/localLibrary'
import type { LocalSong } from '../library/songs'
import { useThemedStyles, type Theme } from '../theme'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'

/** The library, or one playlist used as a source of songs. */
const LIBRARY = 'library'

interface Props {
  title: string
  /** Rendered on the confirm button, given the number selected. Callers word
   *  this differently — "Create" for a new playlist, "Add" for an existing one. */
  confirmLabel: (count: number) => string
  /** Whether confirming with nothing selected is allowed. Creating a playlist
   *  says yes (an empty playlist is a real thing to want); adding tracks to one
   *  says no, because it would be a button that does nothing. */
  allowEmpty?: boolean
  /** Songs already in the destination. Shown, but not selectable — the same
   *  choice `PlaylistPicker` makes for playlists a song is already in. */
  alreadyIn?: ReadonlySet<string>
  busy?: boolean
  onConfirm: (songIds: string[]) => void
  onClose: () => void
}

/**
 * Pick songs — from the library, or from another playlist (#235).
 *
 * ## One component, three callers
 *
 * Creating a playlist with tracks (#235) and adding tracks to one (#236, and
 * #237's 3-dot) are the same interaction with a different verb on the button, so
 * this takes the verb as a prop rather than existing twice. `PlaylistPicker` is
 * the mirror image of it — that one picks playlists for a song, this one picks
 * songs for a playlist — and they are deliberately not merged: they share a
 * shape and nothing else.
 *
 * ## Selection survives switching source
 *
 * The source chips filter what is *listed*, not what is *chosen*. Picking three
 * songs from the library, then two more from an existing playlist, and
 * confirming once is the flow the issue describes ("from the library or from
 * another playlist"), and it only works if the selection outlives the switch.
 *
 * Kept as an array rather than a `Set` because **order is meaningful**:
 * `addSongsToPlaylist` appends in the order given, so the playlist ends up in
 * the order the songs were tapped.
 */
export function SongPicker({
  title,
  confirmLabel,
  allowEmpty = false,
  alreadyIn,
  busy = false,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  const [source, setSource] = useState<string>(LIBRARY)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<readonly string[]>([])

  const { data: playlists } = useLocalPlaylists()
  // The library read is filtered by `useLocalSongs` itself; a playlist's items
  // are filtered below. Both queries stay mounted, which is fine — they are
  // local reads of a cached list, not round trips.
  const { songs: librarySongs, isPending: libraryPending } = useLocalSongs({ q: query })
  const { data: playlistItems, isPending: playlistPending } = useLocalPlaylist(
    source === LIBRARY ? null : source,
  )

  const songs: LocalSong[] = useMemo(() => {
    if (source === LIBRARY) return librarySongs
    const needle = query.trim().toLowerCase()
    const items = (playlistItems ?? []).map((item) => item.song)
    if (!needle) return items
    return items.filter(
      (song) =>
        song.title.toLowerCase().includes(needle) || song.artist.toLowerCase().includes(needle),
    )
  }, [source, librarySongs, playlistItems, query])

  const isPending = source === LIBRARY ? libraryPending : playlistPending
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const toggle = (songId: string) =>
    setSelected((current) =>
      current.includes(songId) ? current.filter((id) => id !== songId) : [...current, songId],
    )

  const canConfirm = !busy && (allowEmpty || selected.length > 0)

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={({ pressed }) => [styles.backdrop, pressed && styles.pressed]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('common.cancel')}
      />
      <View style={styles.sheet}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>
          {t('songPicker.selectedCount', { count: selected.length })}
        </Text>

        {/* Horizontal rather than a dropdown: with a handful of playlists every
            source is one tap away, and the chips show what exists without
            opening anything. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {[{ id: LIBRARY, name: t('songPicker.library') }, ...(playlists ?? [])].map((option) => {
            const active = source === option.id
            return (
              <Chip
                key={option.id}
                label={option.name}
                selected={active}
                onPress={() => setSource(option.id)}
                // Named rather than left to the chip's text: a screen reader
                // otherwise hears a bare playlist name with no clue it filters
                // the list below, and the name alone is ambiguous on a screen
                // that also lists playlists.
                accessibilityLabel={t('songPicker.sourceAria', { name: option.name })}
              />
            )
          })}
        </ScrollView>

        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('songPicker.searchPlaceholder')}
          accessibilityLabel={t('songPicker.searchAria')}
          style={styles.search}
          placeholderTextColor={styles.placeholder.color}
          autoCorrect={false}
        />

        {isPending ? (
          <ActivityIndicator style={styles.loading} />
        ) : songs.length === 0 ? (
          <View style={styles.message}>
            <Text style={styles.messageText}>
              {query.trim() ? t('songPicker.noMatches', { query }) : t('songPicker.empty')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={songs}
            keyExtractor={(song) => song.id}
            style={styles.list}
            extraData={selected}
            renderItem={({ item }) => {
              const already = alreadyIn?.has(item.id) ?? false
              const checked = selectedSet.has(item.id)
              return (
                <Pressable
                  onPress={() => toggle(item.id)}
                  disabled={already}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked, disabled: already }}
                  accessibilityLabel={t(
                    checked ? 'songPicker.deselectAria' : 'songPicker.selectAria',
                    {
                      title: item.title,
                    },
                  )}
                  style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                >
                  {/* A drawn box rather than an icon set, matching the rest of
                      the app's hand-made glyphs. */}
                  <View style={[styles.box, checked && styles.boxChecked]}>
                    {checked ? <Text style={styles.tick}>{'✓'}</Text> : null}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={styles.rowArtist} numberOfLines={1}>
                      {item.artist}
                    </Text>
                  </View>
                  {already ? <Text style={styles.already}>{t('songPicker.alreadyIn')}</Text> : null}
                </Pressable>
              )
            }}
          />
        )}

        <View style={styles.footer}>
          <Button label={t('common.cancel')} variant="plain" onPress={onClose} />
          <Pressable
            onPress={() => onConfirm([...selected])}
            disabled={!canConfirm}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canConfirm }}
            style={({ pressed }) => [
              styles.confirm,
              !canConfirm && styles.confirmDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.confirmText}>{confirmLabel(selected.length)}</Text>
          </Pressable>
        </View>
      </View>
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
      paddingBottom: 16,
      maxHeight: '85%',
    },
    title: { fontSize: 16, fontWeight: '700', paddingHorizontal: 20, color: theme.text },
    subtitle: { fontSize: 13, color: theme.textMuted, paddingHorizontal: 20, marginTop: 2 },
    chips: { paddingHorizontal: 20, paddingVertical: 12, gap: 8 },
    search: {
      marginHorizontal: 20,
      paddingHorizontal: 12,
      paddingVertical: 9,
      borderRadius: 10,
      backgroundColor: theme.surfaceMuted,
      color: theme.text,
      fontSize: 14,
    },
    placeholder: { color: theme.textMuted },
    list: { flexGrow: 0, marginTop: 6 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 20,
      paddingVertical: 11,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    box: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxChecked: { backgroundColor: theme.accentSolid, borderColor: theme.accentSolid },
    tick: { color: theme.accentText, fontSize: 14, fontWeight: '700', lineHeight: 16 },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 15, color: theme.text },
    rowArtist: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
    already: { fontSize: 12, color: theme.textMuted },
    loading: { paddingVertical: 32 },
    message: { padding: 20, gap: 6 },
    messageText: { fontSize: 14, color: theme.textMuted },
    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingHorizontal: 20,
      paddingTop: 14,
      marginTop: 6,
    },
    cancel: { fontSize: 15, color: theme.textMuted },
    confirm: {
      paddingHorizontal: 20,
      paddingVertical: 9,
      borderRadius: 999,
      backgroundColor: theme.accentSolid,
    },
    confirmDisabled: { opacity: 0.4 },
    confirmText: { fontSize: 15, fontWeight: '600', color: theme.accentText },
  })
