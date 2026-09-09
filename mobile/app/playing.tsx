import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { DonateCard } from '../src/components/DonateCard'

import { useLocalFavouriteIds, useSetLocalFavourite } from '../src/api/localPlaylists'
import { MarqueeText } from '../src/components/MarqueeText'
import { PlayerGlyph } from '../src/components/PlayerGlyph'
import { PlayingOptionsSheet } from '../src/components/PlayingOptionsSheet'
import { ProgressScrubber } from '../src/components/ProgressScrubber'
import { TabGlyph } from '../src/components/TabGlyph'
import { usePlaybackStatus } from '../src/player/playbackStatus'
import { usePlayer } from '../src/player/store'
import { useTheme, useThemedStyles, type Theme } from '../src/theme'
import { useGuardedRouter } from '../src/navigation/useGuardedRouter'
import { Button } from '../src/components/ui/Button'

/* Named because the inset has to be added to them at the point of use, and a
 * number repeated in two places drifts. */
const TOP_BAR_PADDING = 6
const BODY_PADDING_BOTTOM = 32

/** How far the skip buttons jump. Matches the lock screen's seek buttons. */
const SKIP_SECONDS = 15

/**
 * The full-screen playing panel (#231).
 *
 * The banner is a summary that opens this (#230); this is the player. Everything
 * the banner gave up lives here with room to be pressed properly — skipping,
 * shuffle, repeat, scrubbing — plus what only a full screen can hold: large
 * artwork, where the queue came from, and the options sheet.
 *
 * ## It is a root route, not a tab
 *
 * Like the queue, it covers the tab bar deliberately: the mini player lives *in*
 * the tab bar, and a mini player underneath the full player would be the same
 * thing twice.
 *
 * ## Position comes from `usePlaybackStatus`, not from the store
 *
 * That split is #226's. `usePlayer` holds intent — the queue, and whether we
 * want sound — and stays pure; `usePlaybackStatus` is what the native player is
 * actually doing. Scrubbing writes back through `seekTo`, which is a *request*
 * the host applies, so this screen still touches no audio.
 */
export default function PlayingScreen() {
  const { t } = useTranslation()
  const router = useGuardedRouter()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  /*
   * This screen hides the navigator's header (`_layout.tsx`), so nothing above
   * it is reserving the status bar, the notch or the punch-hole — the close
   * chevron and the 3-dot sat *inside* them (#305). The horizontal pair is for
   * curved edges, which clip content on every screen in the app today because
   * `useSafeAreaInsets` was not called anywhere at all.
   */
  const insets = useSafeAreaInsets()

  const current = usePlayer((state) => state.current)
  const isPlaying = usePlayer((state) => state.isPlaying)
  const shuffle = usePlayer((state) => state.shuffle)
  const repeat = usePlayer((state) => state.repeat)
  const context = usePlayer((state) => state.context)

  const position = usePlaybackStatus((state) => state.position)
  const duration = usePlaybackStatus((state) => state.duration)
  const isBuffering = usePlaybackStatus((state) => state.isBuffering)
  const error = usePlaybackStatus((state) => state.error)

  const [showOptions, setShowOptions] = useState(false)

  const { data: favouriteIds } = useLocalFavouriteIds()
  const toggleFavourite = useSetLocalFavourite()

  const song = current?.song ?? null
  const onSeek = useCallback((seconds: number) => usePlayer.getState().seekTo(seconds), [])

  /**
   * Nothing playing is a state this screen can genuinely be in — the queue can
   * end while it is open, or a deep link can reach it cold. Saying so beats an
   * empty player with dead controls.
   */
  if (!song) {
    return (
      <View style={[styles.screen, styles.empty, { paddingTop: insets.top }]}>
        <Text style={styles.emptyText}>{t('player.nothingPlaying')}</Text>
        <Button label={t('common.done')} variant="plain" onPress={() => router.back()} />
      </View>
    )
  }

  const isFavourite = favouriteIds ? favouriteIds.has(String(song.id)) : undefined

  return (
    <View
      testID="playing-screen"
      style={[styles.screen, { paddingLeft: insets.left, paddingRight: insets.right }]}
    >
      <View
        testID="playing-top-bar"
        style={[styles.topBar, { paddingTop: TOP_BAR_PADDING + insets.top }]}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel={t('common.done')}
          hitSlop={10}
          style={({ pressed }) => [styles.topButton, pressed && styles.pressed]}
        >
          {/* A chevron pointing down: this panel came up, so it goes back down. */}
          <View style={styles.chevronDown} />
        </Pressable>

        <View style={styles.fromBlock}>
          <Text style={styles.fromLabel}>{t('player.playingFrom')}</Text>
          <Text style={styles.fromName} numberOfLines={1}>
            {context?.name ?? t('player.fromLibrary')}
          </Text>
        </View>

        <Pressable
          onPress={() => setShowOptions(true)}
          accessibilityRole="button"
          accessibilityLabel={t('player.options')}
          hitSlop={10}
          style={({ pressed }) => [styles.topButton, pressed && styles.pressed]}
        >
          <View style={styles.dot} />
          <View style={styles.dot} />
          <View style={styles.dot} />
        </Pressable>
      </View>

      <ScrollView
        testID="playing-body"
        contentContainerStyle={[
          styles.body,
          { paddingBottom: BODY_PADDING_BOTTOM + insets.bottom },
        ]}
      >
        <View style={styles.artworkBox}>
          {song.cover_uri ? (
            <Image
              testID="panel-artwork"
              source={{ uri: song.cover_uri }}
              style={styles.artwork}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ) : (
            <View testID="panel-artwork-placeholder" style={[styles.artwork, styles.artworkEmpty]}>
              <TabGlyph name="library" color={theme.textMuted} size={72} />
            </View>
          )}
        </View>

        <View style={styles.titleRow}>
          <View style={styles.titleText}>
            {/*
             * A marquee, replacing two ellipsized lines (#306).
             *
             * This spot used to carry the argument *against* one: an animation
             * loop running for as long as the panel is open, and text that
             * cannot be read while it moves. I asked for it anyway, for the
             * playing track only — and `MarqueeText` answers the readable half
             * rather than ignoring it, by holding still at both ends and moving
             * slowly between them. It also does nothing at all for a title that
             * fits, which is most of them.
             */}
            <MarqueeText style={styles.title}>{song.title}</MarqueeText>
            <Text style={styles.artist} numberOfLines={1}>
              {song.artist}
            </Text>
          </View>

          {isFavourite !== undefined ? (
            <Pressable
              onPress={() =>
                toggleFavourite.mutate({ songId: String(song.id), favourite: !isFavourite })
              }
              accessibilityRole="button"
              accessibilityLabel={t(isFavourite ? 'song.unfavouriteAria' : 'song.favouriteAria', {
                title: song.title,
              })}
              accessibilityState={{ selected: isFavourite }}
              hitSlop={10}
              style={({ pressed }) => [styles.heartButton, pressed && styles.pressed]}
            >
              <Text style={[styles.heart, isFavourite && styles.hearted]}>
                {isFavourite ? '♥' : '♡'}
              </Text>
            </Pressable>
          ) : null}
        </View>

        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {t('player.playbackFailed')}
          </Text>
        ) : null}

        <ProgressScrubber position={position} duration={duration} onSeek={onSeek} />

        <View style={styles.transport}>
          <Pressable
            onPress={() => usePlayer.getState().toggleShuffle()}
            accessibilityRole="button"
            accessibilityLabel={t('player.shuffle')}
            accessibilityState={{ selected: shuffle }}
            hitSlop={8}
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
          >
            <PlayerGlyph
              name="shuffle"
              size={20}
              color={shuffle ? theme.accentOnSurface : theme.textMuted}
            />
          </Pressable>

          <Pressable
            onPress={() => usePlayer.getState().previous()}
            accessibilityRole="button"
            accessibilityLabel={t('player.previous')}
            hitSlop={8}
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
          >
            <PlayerGlyph name="previous" size={24} color={theme.text} />
          </Pressable>

          <Pressable
            onPress={() => usePlayer.getState().togglePlay()}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? t('player.pause') : t('player.play')}
            style={({ pressed }) => [styles.playButton, pressed && styles.pressed]}
          >
            <PlayerGlyph name={isPlaying ? 'pause' : 'play'} size={26} color={theme.accentText} />
          </Pressable>

          <Pressable
            onPress={() => usePlayer.getState().next()}
            accessibilityRole="button"
            accessibilityLabel={t('player.next')}
            hitSlop={8}
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
          >
            <PlayerGlyph name="next" size={24} color={theme.text} />
          </Pressable>

          <Pressable
            onPress={() => usePlayer.getState().cycleRepeat()}
            accessibilityRole="button"
            accessibilityLabel={t('player.repeatAria', { mode: t(`player.repeatMode.${repeat}`) })}
            accessibilityState={{ selected: repeat !== 'off' }}
            hitSlop={8}
            style={({ pressed }) => [styles.smallButton, pressed && styles.pressed]}
          >
            <PlayerGlyph
              name={repeat === 'one' ? 'repeat-one' : 'repeat'}
              size={20}
              color={repeat === 'off' ? theme.textMuted : theme.accentOnSurface}
            />
            {/*
              The `1` is gone and the `∞` stays, and the asymmetry is the point
              (#326).

              `Repeat1` draws the digit inside the mark, so a `1` beside it was
              saying the same thing twice. Nothing distinguishes *all* from
              *off* except colour, though, and the note this replaces was right
              that colour alone is not a state anyone can read — so that one
              keeps its label. The web client does leave off-vs-all to colour;
              this is deliberately better rather than identical.
            */}
            {repeat === 'all' ? <Text style={styles.repeatMode}>∞</Text> : null}
          </Pressable>
        </View>

        <View style={styles.skipRow}>
          <Pressable
            onPress={() => onSeek(Math.max(position - SKIP_SECONDS, 0))}
            accessibilityRole="button"
            accessibilityLabel={t('player.back15')}
            style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}
          >
            <Text style={styles.skipText}>−{SKIP_SECONDS}s</Text>
          </Pressable>
          <Pressable
            onPress={() =>
              // Clamped to the track: seeking past the end is undefined on the
              // native player, and "skip forward" should never mean "next".
              onSeek(duration > 0 ? Math.min(position + SKIP_SECONDS, duration) : position)
            }
            accessibilityRole="button"
            accessibilityLabel={t('player.forward15')}
            style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}
          >
            <Text style={styles.skipText}>+{SKIP_SECONDS}s</Text>
          </Pressable>
        </View>

        <Pressable
          onPress={() => router.push('/queue')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.queueButton, pressed && styles.pressed]}
        >
          <Text style={styles.queueText}>{t('player.openQueue')}</Text>
        </Pressable>

        {isBuffering ? <Text style={styles.buffering}>{t('player.buffering')}</Text> : null}

        {/* At the bottom of the screen someone reaches while actually enjoying
            the app, which is my call on where an ask belongs (#517). Below
            every control, so it is never in the way of playing music. */}
        <DonateCard compact />
      </ScrollView>

      {showOptions ? (
        <PlayingOptionsSheet
          song={song}
          onClose={() => setShowOptions(false)}
          onOpenQueue={() => {
            setShowOptions(false)
            router.push('/queue')
          }}
        />
      ) : null}
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    screen: { flex: 1, backgroundColor: theme.background },
    empty: { alignItems: 'center', justifyContent: 'center', gap: 10 },
    emptyText: { fontSize: 15, color: theme.textMuted },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingTop: TOP_BAR_PADDING,
      paddingBottom: 4,
      gap: 8,
    },
    topButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', gap: 3 },
    chevronDown: {
      width: 11,
      height: 11,
      borderRightWidth: 2,
      borderBottomWidth: 2,
      borderColor: theme.text,
      transform: [{ rotate: '45deg' }],
      marginTop: -4,
    },
    dot: { width: 3.5, height: 3.5, borderRadius: 999, backgroundColor: theme.text },
    fromBlock: { flex: 1, minWidth: 0, alignItems: 'center' },
    fromLabel: {
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: theme.textMuted,
    },
    fromName: { fontSize: 13, fontWeight: '600', color: theme.text },
    body: { paddingHorizontal: 24, paddingBottom: BODY_PADDING_BOTTOM, gap: 4 },
    artworkBox: { alignItems: 'center', paddingVertical: 20 },
    // Square, and sized by the container rather than the screen: a fixed pixel
    // size would crop on a small phone and float on a large one.
    artwork: {
      width: '100%',
      aspectRatio: 1,
      borderRadius: 12,
      backgroundColor: theme.surfaceMuted,
    },
    artworkEmpty: { alignItems: 'center', justifyContent: 'center' },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    titleText: { flex: 1, minWidth: 0 },
    title: { fontSize: 22, fontWeight: '700', color: theme.text },
    artist: { fontSize: 15, color: theme.textMuted, marginTop: 4 },
    heartButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    heart: { fontSize: 26, color: theme.textMuted, lineHeight: 30 },
    hearted: { color: theme.accentOnSurface },
    error: { fontSize: 13, color: theme.danger, marginTop: 8 },
    transport: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 8,
    },
    smallButton: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      flexDirection: 'row',
      gap: 3,
    },
    repeatMode: { fontSize: 11, fontWeight: '700', color: theme.accentOnSurface },
    playButton: {
      width: 64,
      height: 64,
      borderRadius: 999,
      backgroundColor: theme.accentSolid,
      alignItems: 'center',
      justifyContent: 'center',
    },
    skipRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 4 },
    skipButton: { paddingVertical: 10, paddingHorizontal: 14 },
    skipText: { fontSize: 14, color: theme.textMuted, fontVariant: ['tabular-nums'] },
    queueButton: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 16 },
    queueText: { fontSize: 14, color: theme.accentOnSurface, fontWeight: '600' },
    buffering: { fontSize: 12, color: theme.textMuted, textAlign: 'center' },
  })
