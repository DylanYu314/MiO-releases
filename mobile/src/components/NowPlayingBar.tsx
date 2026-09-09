import { useTranslation } from 'react-i18next'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'

import type { PlayableSong } from '../api/types'
import { useTheme, useThemedStyles, type Theme } from '../theme'
import { MarqueeText } from './MarqueeText'
import { TabGlyph } from './TabGlyph'

interface Props {
  song: PlayableSong
  isPlaying: boolean
  position: number
  duration: number
  isBuffering: boolean
  error: string | null
  onToggle: () => void
  /** Open the full-screen playing panel (#231). */
  onOpen: () => void
  /** Hearted state. `undefined` hides the heart, before the ids have loaded. */
  isFavourite?: boolean
  onToggleFavourite?: (favourite: boolean) => void
}

/**
 * The now-playing banner: thumbnail · title · artist · play/pause · heart (#230).
 *
 * **A summary that opens the player, not the player.** It used to carry previous
 * and next as well, on the reasoning that the lock screen cannot have them and
 * in-app was therefore the only place skipping could exist. That is still true,
 * and skipping moved to the playing panel rather than disappearing — a strip
 * this size with five controls is a strip with five mis-taps, and the panel has
 * room to do each of them properly.
 *
 * Tapping anywhere that is not a button opens the panel. The two buttons are the
 * ones worth having without leaving the screen you are on: pausing, and hearting
 * the thing you are hearing.
 */
export function NowPlayingBar({
  song,
  isPlaying,
  position,
  duration,
  isBuffering,
  error,
  onToggle,
  onOpen,
  isFavourite,
  onToggleFavourite,
}: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()

  // Guard the divide: duration is 0 until the stream's header has been read.
  const progress = duration > 0 ? Math.min(position / duration, 1) : 0

  // The timecode went to the panel with #230. It is unreadable at this size and
  // the progress line already says roughly where the track is; what belongs here
  // is what the strip is *for* — which song, and is it playing.
  const subtitle = () => {
    if (error) return t('player.playbackFailed')
    if (isBuffering) return t('player.buffering')
    return song.artist
  }

  return (
    <View style={styles.container}>
      <View style={styles.track}>
        <View testID="banner-progress" style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>

      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={t('player.openPanel')}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {song.cover_uri ? (
          <Image
            testID="banner-artwork"
            source={{ uri: song.cover_uri }}
            style={styles.thumbnail}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        ) : (
          <View
            testID="banner-artwork-placeholder"
            style={[styles.thumbnail, styles.thumbnailEmpty]}
          >
            <TabGlyph name="library" color={theme.textMuted} size={18} />
          </View>
        )}

        <View style={styles.text}>
          {/* The bar is the other place the *playing* track's title shows, so
              it marquees too (#306). Rows in a list deliberately do not. */}
          <MarqueeText style={styles.title}>{song.title}</MarqueeText>
          <Text style={[styles.subtitle, error ? styles.error : null]} numberOfLines={1}>
            {subtitle()}
          </Text>
        </View>

        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? t('player.pause') : t('player.play')}
          hitSlop={10}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          {isPlaying ? (
            <View style={styles.pauseGlyph}>
              <View style={styles.pauseBar} />
              <View style={styles.pauseBar} />
            </View>
          ) : (
            <View style={styles.playGlyph} />
          )}
        </Pressable>

        {isFavourite !== undefined && onToggleFavourite ? (
          <Pressable
            onPress={() => onToggleFavourite(!isFavourite)}
            accessibilityRole="button"
            accessibilityLabel={t(isFavourite ? 'song.unfavouriteAria' : 'song.favouriteAria', {
              title: song.title,
            })}
            accessibilityState={{ selected: isFavourite }}
            hitSlop={10}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}
          >
            <Text style={[styles.heart, isFavourite && styles.hearted]}>
              {isFavourite ? '♥' : '♡'}
            </Text>
          </Pressable>
        ) : null}
      </Pressable>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
    },
    track: { height: 2, backgroundColor: theme.surfaceMuted },
    fill: { height: 2, backgroundColor: theme.accentSolid },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 12,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    thumbnail: { width: 40, height: 40, borderRadius: 5, backgroundColor: theme.surfaceMuted },
    thumbnailEmpty: { alignItems: 'center', justifyContent: 'center' },
    // Without a zero minimum a flex child will not shrink, so a long title pushes
    // the buttons off the screen instead of ellipsizing.
    text: { flex: 1, minWidth: 0 },
    title: { fontSize: 14, fontWeight: '600', color: theme.text },
    subtitle: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
    error: { color: theme.danger },
    button: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
    },
    playGlyph: {
      width: 0,
      height: 0,
      borderTopWidth: 9,
      borderBottomWidth: 9,
      borderLeftWidth: 15,
      borderTopColor: 'transparent',
      borderBottomColor: 'transparent',
      borderLeftColor: theme.accentOnSurface,
      marginLeft: 3,
    },
    pauseGlyph: { flexDirection: 'row', gap: 4 },
    pauseBar: { width: 5, height: 18, backgroundColor: theme.accentOnSurface, borderRadius: 1 },
    heart: { fontSize: 20, color: theme.textMuted, lineHeight: 22 },
    hearted: { color: theme.accentOnSurface },
  })
