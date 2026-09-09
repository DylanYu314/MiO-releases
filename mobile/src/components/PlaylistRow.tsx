import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { LocalPlaylist } from '../library/playlists'
import { useThemedStyles, type Theme } from '../theme'

interface Props {
  playlist: LocalPlaylist
  onPress: (playlist: LocalPlaylist) => void
  /**
   * Whether this row is chosen, while the list is selecting (#570).
   *
   * `undefined` means "not selectable", which is what leaves every existing
   * caller unchanged — the same contract `SongRow` has carried since #336, and
   * the reason adding selection here costs one prop rather than a variant.
   */
  selected?: boolean
}

/**
 * One playlist in the list. Memoized for the same reason `SongRow` is — the
 * list re-renders its window on every page fetch — so `onPress` has to be a
 * stable reference for the memo to be worth anything.
 */
function PlaylistRowComponent({ playlist, onPress, selected }: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  const selecting = selected !== undefined

  return (
    <Pressable
      onPress={() => onPress(playlist)}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityLabel={
        selecting
          ? t(selected ? 'select.deselectAria' : 'select.selectAria', { title: playlist.name })
          : t('playlists.openAria', { name: playlist.name })
      }
      accessibilityState={selecting ? { selected } : undefined}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {selecting ? (
        <View
          style={[styles.tick, selected && styles.tickOn]}
          // Decorative: the row already carries the checkbox role and its
          // state, so announcing this too would say everything twice.
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          {selected ? <Text style={styles.tickMark}>✓</Text> : null}
        </View>
      ) : null}

      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {playlist.name}
        </Text>
        <Text style={styles.count}>{t('playlists.songCount', { count: playlist.item_count })}</Text>
      </View>
      {/* The chevron means "this opens something", which it does not while
          selecting. A tick on the left and an arrow on the right at the same
          time is two different promises about one press. */}
      {selecting ? null : <Text style={styles.chevron}>›</Text>}
    </Pressable>
  )
}

export const PlaylistRow = memo(PlaylistRowComponent)

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 14,
      paddingHorizontal: 16,
      gap: 12,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    text: { flex: 1, minWidth: 0 },
    name: { fontSize: 16, fontWeight: '500', color: theme.text },
    count: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
    chevron: { fontSize: 22, color: theme.textMuted },
    // Copied from `SongRow` deliberately rather than shared: they are two
    // lists, and a shared "tick" component would be one more indirection than
    // twenty lines of style is worth. If a third appears, extract it then.
    tick: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tickOn: { backgroundColor: theme.accentSolid, borderColor: theme.accentSolid },
    tickMark: { color: theme.accentText, fontSize: 13, fontWeight: '700', lineHeight: 16 },
  })
