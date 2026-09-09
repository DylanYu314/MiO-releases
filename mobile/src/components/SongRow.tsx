import { memo, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { isPlayable, type PlayableSong } from '../api/types'
import { useTheme, useThemedStyles, type Theme } from '../theme'
import { SwipeableRow } from './SwipeableRow'
import { TabGlyph } from './TabGlyph'

/** The artwork square, and therefore the row's height. 48 is the smallest that
 *  still reads as a picture rather than a coloured dot. */
const THUMBNAIL = 48

/** Vertical padding, above and below. */
const ROW_PADDING = 8

/**
 * How tall one row is, exported so a list can tell `FlatList` without measuring
 * (#239) — `scrollToIndex` cannot reach a row that has never been rendered
 * unless `getItemLayout` says where it is.
 *
 * The thumbnail sets the height: it is 48, while the two lines of text come to
 * about 36 and the icon buttons are 40, so both fit inside it. Derived from the
 * constants rather than written as `64`, so changing either moves this with it.
 */
export const SONG_ROW_HEIGHT = THUMBNAIL + ROW_PADDING * 2

interface Props {
  song: PlayableSong
  onPress: (song: PlayableSong) => void
  /**
   * Open the options panel (#229). The 3-dot is the primary way in; long-press
   * calls the same handler and survives only as a shortcut for people who
   * already have the habit.
   */
  onOptions?: (song: PlayableSong) => void
  /** True for the track the player currently holds — playing *or* paused. */
  isCurrent: boolean
  isPlaying: boolean
  /** Whether this song is hearted. `undefined` hides the heart entirely, for a
   *  list where favouriting makes no sense or the ids have not loaded. */
  isFavourite?: boolean
  onToggleFavourite?: (song: PlayableSong, favourite: boolean) => void
  /** True while this row's audio is being fetched, so the label can say so
   *  rather than the row looking inert. */
  isDownloading?: boolean
  /**
   * Swipe the row rightwards to queue it (#316).
   *
   * Optional, and absent means **no gesture is created at all** — a list where
   * queueing makes no sense should not quietly grow a gesture, and a row that
   * ignores a swipe it appeared to accept is worse than one that never moved.
   */
  onSwipeEnqueue?: (song: PlayableSong) => void
  /**
   * Selection mode (#336).
   *
   * Undefined means the row is not selectable, which is the ordinary state and
   * keeps every existing caller unchanged. Defined means the list is in
   * selection mode: a tick replaces the artwork's role as the leading element,
   * pressing toggles instead of playing, and the heart and 3-dot are hidden
   * because acting on one song is not what this mode is for.
   */
  selected?: boolean
}

/**
 * One song in a list: thumbnail · title · artist · heart · 3-dot (#228).
 *
 * The most-repeated element in the app, which is why it is worth the care. It
 * used to be title and artist with a heart, and **its actions were behind a long
 * press nobody discovers** — a gesture with no affordance is a feature only its
 * author knows about. The 3-dot is that affordance (#229).
 *
 * ## The thumbnail could not exist before #218
 *
 * Artwork was a separate owned endpoint, and the OS cannot send our headers, so
 * `/songs/{id}/cover` 404'd for every row. `cover_uri` is a local `file://` path
 * and needs headers from nobody — which is the only reason this column can hold
 * a picture at all.
 *
 * A song with no cover is normal, not broken: plenty of sources have none, and
 * a row whose import predates the column simply has not fetched one yet. Both
 * get the placeholder.
 *
 * Memoized because a list re-renders its window as it scrolls, and a row that
 * re-renders for no reason is the usual cause of a list that stutters. `onPress`
 * and `onOptions` must therefore be stable references, or the memo buys nothing.
 */
function SongRowComponent({
  song,
  onPress,
  onOptions,
  isCurrent,
  isPlaying,
  isFavourite,
  onToggleFavourite,
  isDownloading,
  onSwipeEnqueue,
  selected,
}: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()

  const selecting = selected !== undefined

  return (
    <SwipeToEnqueue
      song={song}
      // No swiping while selecting: a sideways drag on a row the user is
      // ticking would queue a song they were only trying to choose.
      onEnqueue={selecting ? undefined : onSwipeEnqueue}
    >
      <Pressable
        onPress={() => onPress(song)}
        // Long-press already means "open the sheet" here and "start dragging" on
        // a playlist, so selection deliberately does **not** claim it (#336) —
        // a third meaning for one gesture is a conflict, not a shortcut. While
        // selecting, it means nothing at all rather than something surprising.
        onLongPress={onOptions && !selecting ? () => onOptions(song) : undefined}
        accessibilityRole={selecting ? 'checkbox' : 'button'}
        accessibilityLabel={
          selecting
            ? t(selected ? 'select.deselectAria' : 'select.selectAria', { title: song.title })
            : t(isPlaying && isCurrent ? 'song.pauseAria' : 'song.playAria', { title: song.title })
        }
        accessibilityState={{ selected: selecting ? selected : isCurrent }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {selecting ? (
          <View
            style={[styles.tick, selected && styles.tickOn]}
            // Decorative: the row itself already carries the checkbox role and
            // its state, so announcing this too would say everything twice.
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {selected ? <Text style={styles.tickMark}>✓</Text> : null}
          </View>
        ) : null}

        <Artwork song={song} styles={styles} placeholderColor={theme.textMuted} />

        <View style={styles.text}>
          <Text style={[styles.title, isCurrent && styles.current]} numberOfLines={1}>
            {song.title}
          </Text>
          <Text style={styles.artist} numberOfLines={1}>
            {song.artist}
            {/* A row with no audio and no server copy cannot play at all (#268).
              Saying so is the difference between "not downloaded yet" and an
              app that goes silent when you tap it — and a playlist import now
              creates these on purpose, so the user can see what it contained. */}
            {/* "Tap to get it", not just "Not downloaded" (#377's UI 9 again).
                Tapping the row *does* fetch the audio — that is what makes a
                track a playlist import could not get recoverable at all — and
                on 2026-08-09 I found it by accident, having read the row as
                a statement of fact rather than an offer. A gesture with no hint
                is a gesture nobody has. */}
            {!isPlayable(song) ? (
              <Text style={styles.pending}>
                {`  ·  ${isDownloading ? t('song.downloading') : t('song.notDownloaded')}`}
              </Text>
            ) : null}
          </Text>
        </View>

        {/* The duration went with #228. It was the least useful thing competing
          for the right-hand side, and the 3-dot needed the room — the playing
          panel and the queue both still show it, where it is actually read. */}
        {/* Hidden while selecting: this mode is about acting on many songs, and
          a heart that still works on one is an invitation to lose the
          selection by tapping the wrong thing. */}
        {!selecting && isFavourite !== undefined && onToggleFavourite ? (
          <Pressable
            // Nested inside the row's Pressable, so the tap must not also start
            // the song. React Native stops at the innermost responder, which is
            // what makes this safe — but hitSlop is kept small for the same
            // reason: a generous target here would steal taps from the row.
            onPress={() => onToggleFavourite(song, !isFavourite)}
            accessibilityRole="button"
            accessibilityLabel={t(isFavourite ? 'song.unfavouriteAria' : 'song.favouriteAria', {
              title: song.title,
            })}
            accessibilityState={{ selected: isFavourite }}
            hitSlop={8}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Text style={[styles.heart, isFavourite && styles.hearted]}>
              {isFavourite ? '♥' : '♡'}
            </Text>
          </Pressable>
        ) : null}

        {!selecting && onOptions ? (
          <Pressable
            onPress={() => onOptions(song)}
            accessibilityRole="button"
            accessibilityLabel={t('song.optionsAria', { title: song.title })}
            hitSlop={8}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            {/* Three dots from three views rather than a glyph: the character
              ⋮ sits on the text baseline and its spacing varies by font, so it
              drifts against the heart beside it. */}
            <View style={styles.dot} />
            <View style={styles.dot} />
            <View style={styles.dot} />
          </Pressable>
        ) : null}
      </Pressable>
    </SwipeToEnqueue>
  )
}

/**
 * The cover, or a placeholder.
 *
 * Split out so the row body stays readable, and deliberately *not* its own
 * memoized component — it is cheap, and another `memo` boundary inside an
 * already-memoized row buys nothing.
 */
function Artwork({
  song,
  styles,
  placeholderColor,
}: {
  song: PlayableSong
  styles: ReturnType<typeof makeStyles>
  placeholderColor: string
}) {
  if (song.cover_uri) {
    return (
      <Image
        testID="song-artwork"
        source={{ uri: song.cover_uri }}
        style={styles.thumbnail}
        // The picture is decoration: the title beside it already names the song,
        // so announcing it again would make every row read twice.
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
    )
  }

  return (
    <View testID="song-artwork-placeholder" style={[styles.thumbnail, styles.thumbnailEmpty]}>
      <TabGlyph name="library" color={placeholderColor} size={22} />
    </View>
  )
}

export const SongRow = memo(SongRowComponent)

/**
 * Swipe the row rightwards to queue it (#316).
 *
 * The gesture itself lives in `SwipeableRow` since #379, which needed the same
 * thing leftwards on the queue. ADR-018's rule is to reuse the composition
 * answer rather than tune a gesture per screen; this is what is left once that
 * is honoured — the label and the handler.
 */
function SwipeToEnqueue({
  song,
  onEnqueue,
  children,
}: {
  song: PlayableSong
  onEnqueue?: (song: PlayableSong) => void
  children: ReactNode
}) {
  const { t } = useTranslation()

  return (
    <SwipeableRow
      direction="right"
      label={t('song.queue')}
      testId={String(song.id)}
      onCommit={onEnqueue ? () => onEnqueue(song) : undefined}
    >
      {children}
    </SwipeableRow>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: ROW_PADDING,
      paddingHorizontal: 16,
      gap: 12,
      // Fixed, so `SONG_ROW_HEIGHT` is a fact rather than an estimate — a
      // `getItemLayout` that disagrees with reality scrolls to the wrong place
      // and there is nothing on screen to suggest why.
      height: SONG_ROW_HEIGHT,
    },
    /* The selection tick (#336).
     *
     * Drawn from a bordered view rather than an icon, the same approach the
     * chevron and the transport controls take — `react-native-svg` exists now
     * but a circle and a check character need it no more than they did. */
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
    pressed: { backgroundColor: theme.surfacePressed },
    swipeContainer: { position: 'relative', overflow: 'hidden' },
    swipeBackdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.accentSolid,
      justifyContent: 'center',
      paddingLeft: 20,
    },
    swipeLabel: { fontSize: 13, fontWeight: '600', color: theme.accentText },
    thumbnail: {
      width: THUMBNAIL,
      height: THUMBNAIL,
      borderRadius: 6,
      backgroundColor: theme.surfaceMuted,
    },
    thumbnailEmpty: { alignItems: 'center', justifyContent: 'center' },
    // Without a minimum of zero a flex child refuses to shrink, so a long title
    // pushes the buttons off the screen instead of ellipsizing.
    text: { flex: 1, minWidth: 0 },
    title: { fontSize: 15, fontWeight: '500', color: theme.text },
    current: { color: theme.accentOnSurface, fontWeight: '700' },
    pending: { color: theme.warning },
    artist: { fontSize: 13, color: theme.textMuted, marginTop: 2 },
    iconButton: {
      width: 32,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
    },
    // A filled vs outlined heart rather than a colour change alone: colour is not
    // a state anyone can read reliably, and this app has no icon set.
    heart: { fontSize: 20, color: theme.textMuted, lineHeight: 22 },
    hearted: { color: theme.accentOnSurface },
    dot: { width: 3.5, height: 3.5, borderRadius: 999, backgroundColor: theme.textMuted },
  })
