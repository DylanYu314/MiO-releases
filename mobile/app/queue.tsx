import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { formatDuration } from '../src/api/songs'
import type { PlayableSong } from '../src/api/types'
import { DraggableList } from '../src/components/DraggableList'
import { HintBanner, useHintDismissal } from '../src/components/HintBanner'
import { ScrollWindowProvider, useScrollWindowSource } from '../src/components/ScrollWindow'
import { SwipeableRow } from '../src/components/SwipeableRow'
import { SleepTimerSheet } from '../src/components/SleepTimerSheet'
import { TabGlyph } from '../src/components/TabGlyph'
import { useMountTiming } from '../src/diagnostics/mountTiming'
import { upNext, usePlayer } from '../src/player/store'
import { useSleepCountdown } from '../src/player/useSleepCountdown'
import { useTheme, useThemedStyles, type Theme } from '../src/theme'
import { Button } from '../src/components/ui/Button'
import { Chip } from '../src/components/ui/Chip'

/** The fixed part of the bottom padding; the inset is added at the point of
 *  use, so the number lives in one place. */
const CONTAINER_PADDING_BOTTOM = 40

/** Every queue row is this tall, which is what lets the drag maths be a
 *  division rather than a per-row measurement. */
const ROW_HEIGHT = 56

/**
 * The play queue (#233).
 *
 * It shows the two tiers separately because they behave differently and users
 * are entitled to know which is which: entries under "Next in queue" were put
 * there by hand and survive starting a new playlist, while "Up next" is whatever
 * list is currently playing and is replaced wholesale.
 *
 * ## The promise this screen is built around
 *
 * **Tapping a track under "Up next" skips to it without consuming the user
 * queue.** That is ADR-011's whole point, and it is the thing the obvious
 * implementation breaks: calling `playFromContext` would replace the context and
 * strand every hand-queued song behind a pointer that has moved past them. The
 * store has `skipToContext` for exactly this, and a test asserts a hand-built
 * queue survives the skip.
 *
 * ## Drag and multi-select do not share a gesture
 *
 * Holding a row starts a drag; selecting is a mode entered from the section
 * header. Overloading long-press with both would make one of them unreachable,
 * and the drag is the one with no other affordance.
 */
export default function QueueScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  // Retired by the swipe itself, not by the × on the row — the × is the
  // long-standing button and using it teaches nobody the gesture (#502).
  const learnedSwipe = useHintDismissal('swipeToRemove')
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const countdown = useSleepCountdown()
  const [showSleep, setShowSleep] = useState(false)
  /*
   * Publishes what is on screen, so the lists below can mount only the rows
   * near it (#503). The offset lives in a ref inside this, not in state — a
   * scroll offset in state would re-render this screen every frame, which is
   * most of the cost the windowing exists to remove.
   */
  const scrollWindow = useScrollWindowSource()

  const current = usePlayer((state) => state.current)
  const userQueue = usePlayer((state) => state.userQueue)
  const context = usePlayer((state) => state.context)
  const contextQueue = usePlayer((state) => state.contextQueue)
  const contextOrder = usePlayer((state) => state.contextOrder)
  const contextIndex = usePlayer((state) => state.contextIndex)
  const shuffle = usePlayer((state) => state.shuffle)
  const repeat = usePlayer((state) => state.repeat)
  const sleepAt = usePlayer((state) => state.sleepAt)
  const sleepAfterTrack = usePlayer((state) => state.sleepAfterTrack)

  /** Indices into the user queue, or null when not selecting. */
  const [selected, setSelected] = useState<readonly number[] | null>(null)
  const selecting = selected !== null

  // Memoized rather than selected: a selector building a new array each render
  // breaks zustand's snapshot equality.
  const upcoming = useMemo(
    () => upNext(contextQueue, contextOrder, contextIndex),
    [contextQueue, contextOrder, contextIndex],
  )

  /*
   * How long this screen took to open, and which open it was (#503).
   *
   * Counts only — a title here would be a record of what someone listens to,
   * uploaded daily, which is the invariant #354 exists to hold.
   *
   * The two lengths are in the line because they are what separates the
   * remaining candidates: if the time rises with them it is the lists, and if it
   * is flat it is the route.
   */
  useMountTiming('queue', `userQueue=${userQueue.length} context=${upcoming.length}`)

  const contextHeading = context?.name
    ? t('queue.nextFromNamed', { name: context.name })
    : t('queue.nextFrom')

  const toggleSelected = (index: number) =>
    setSelected((current) =>
      current === null
        ? [index]
        : current.includes(index)
          ? current.filter((i) => i !== index)
          : [...current, index],
    )

  /*
   * A countdown, not a clock reading (#314).
   *
   * This used to render `sleepAt` as an absolute time and never tick, so
   * "stopping at 23:14" sat there unchanged from arming until firing — and a
   * timer set for under a minute showed the current minute, which reads as
   * "stopping now".
   */
  const sleepLabel = () => {
    if (sleepAfterTrack) return t('player.sleepSetEndOfTrack')
    if (countdown === null) return t('player.sleepOff')
    return t('player.sleepStoppingIn', { time: formatDuration(countdown) })
  }

  return (
    // Outside the ScrollView: a context provider renders no view of its own, so
    // the lists' `onLayout` y stays an offset within the scrolled content.
    <ScrollWindowProvider source={scrollWindow}>
      <ScrollView
        testID="queue-scroll"
        onScroll={scrollWindow.onScroll}
        onLayout={scrollWindow.onLayout}
        // 16 ms, so the window is recomputed from a fresh offset rather than
        // from the default one-event-per-scroll. The recompute is a comparison
        // of two integers and sets state only when the window moves.
        scrollEventThrottle={16}
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[
          styles.container,
          {
            // The queue covers the tab bar, so nothing below it is reserving the
            // gesture bar — the last row sat under it (#305).
            paddingBottom: CONTAINER_PADDING_BOTTOM + insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={styles.controls}>
          <Chip
            label={t('player.shuffle')}
            selected={shuffle}
            onPress={() => usePlayer.getState().toggleShuffle()}
          />
          <Chip
            label={t(`player.repeatLabel.${repeat}`)}
            selected={repeat !== 'off'}
            onPress={() => usePlayer.getState().cycleRepeat()}
            // The label says which mode is *next*; the accessible name says which
            // is on. Both are needed and they are not the same sentence.
            accessibilityLabel={t('player.repeatAria', { mode: t(`player.repeatMode.${repeat}`) })}
          />
          {/*
          Pressable now (#313). It was a `View` by an explicit decision — the
          timer was set only from the playing panel's options sheet, and two
          places to change it meant two places to keep in step. That was
          reasonable once and is wrong from a screen that shows the timer and
          will not let you touch it: I pressed it and nothing happened.
        */}
          <Chip
            label={`${t('player.sleepTimer')} · ${sleepLabel()}`}
            selected={sleepAt !== null || sleepAfterTrack}
            onPress={() => setShowSleep(true)}
          />
        </View>

        <Text style={styles.heading}>{t('queue.nowPlaying')}</Text>
        {current ? (
          <QueueRow song={current.song} styles={styles} theme={theme} highlighted />
        ) : (
          <Text style={styles.empty}>{t('queue.nothingPlaying')}</Text>
        )}

        <View style={styles.headingRow}>
          <Text style={styles.heading}>{t('queue.nextInQueue')}</Text>
          {userQueue.length > 0 ? (
            <View style={styles.headingActions}>
              {selecting ? (
                <>
                  <Text style={styles.selectedCount}>
                    {t('queue.selectedCount', { count: selected.length })}
                  </Text>
                  <Button
                    label={t('queue.promoteSelected')}
                    variant="plain"
                    onPress={() => {
                      usePlayer.getState().promoteInUserQueue(selected)
                      setSelected(null)
                    }}
                    disabled={selected.length === 0}
                  />
                  <Button
                    label={t('queue.removeSelected')}
                    variant="plain"
                    onPress={() => {
                      usePlayer.getState().removeManyFromUserQueue(selected)
                      setSelected(null)
                    }}
                    disabled={selected.length === 0}
                  />
                  <Button
                    label={t('common.cancel')}
                    variant="plain"
                    onPress={() => setSelected(null)}
                  />
                </>
              ) : (
                <>
                  <Button
                    label={t('queue.select')}
                    variant="plain"
                    onPress={() => setSelected([])}
                  />
                  <Button
                    label={t('queue.clear')}
                    variant="plain"
                    onPress={() => usePlayer.getState().clearUserQueue()}
                  />
                </>
              )}
            </View>
          ) : null}
        </View>

        {userQueue.length === 0 ? (
          <Text style={styles.empty}>{t('queue.emptyUser')}</Text>
        ) : selecting ? (
          // Drag is off while selecting: the two would fight for the same finger,
          // and a checkbox that sometimes reorders instead is worse than either.
          userQueue.map((song, index) => (
            <Pressable
              key={`${song.id}-${index}`}
              onPress={() => toggleSelected(index)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected.includes(index) }}
              accessibilityLabel={t(
                selected.includes(index) ? 'queue.deselectAria' : 'queue.selectAria',
                {
                  title: song.title,
                },
              )}
              style={({ pressed }) => [pressed && styles.pressed]}
            >
              <QueueRow
                song={song}
                styles={styles}
                theme={theme}
                checked={selected.includes(index)}
              />
            </Pressable>
          ))
        ) : (
          <>
            <Text style={styles.hint}>{t('queue.reorderHint')}</Text>
            {/* Inside the non-selecting branch, so it appears exactly where the
              swipe is available (#502). */}
            <HintBanner id="swipeToRemove" messageKey="queue.swipeHint" />
            <DraggableList
              items={userQueue}
              keyOf={(song, index) => `${song.id}-${index}`}
              rowHeight={ROW_HEIGHT}
              onReorder={(from, to) => usePlayer.getState().reorderUserQueue(from, to)}
              renderItem={(song, index) => (
                /*
                 * Swipe left to remove (#379), the mirror of the library's
                 * swipe-right to queue. Cheap once the gesture is a component:
                 * `SwipeableRow` is the same one `SongRow` uses, pointed the
                 * other way, which is what ADR-018 means by reusing the
                 * composition answer rather than tuning one per screen.
                 *
                 * The × button stays. A gesture is a shortcut for people who
                 * know it exists, never the only way to do something — which is
                 * the whole of #377's UI 9.
                 */
                <SwipeableRow
                  direction="left"
                  tone="danger"
                  label={t('queue.swipeRemove')}
                  testId={`queue-${song.id}-${index}`}
                  onCommit={() => {
                    usePlayer.getState().removeFromUserQueue(index)
                    learnedSwipe()
                  }}
                >
                  <QueueRow
                    song={song}
                    styles={styles}
                    theme={theme}
                    onRemove={() => usePlayer.getState().removeFromUserQueue(index)}
                    removeLabel={t('queue.removeAria', { title: song.title })}
                  />
                </SwipeableRow>
              )}
            />
          </>
        )}

        <Text style={styles.heading}>{contextHeading}</Text>
        {upcoming.length === 0 ? (
          <Text style={styles.empty}>{t('queue.emptyContext')}</Text>
        ) : (
          /*
           * Draggable too, since #315 — it was a bare `.map()` while the user
           * queue above it could be reordered, which is an inconsistency you can
           * only discover by trying.
           *
           * Two drag lists inside one `ScrollView` is the thing the issue warned
           * might fight the scroll. It does not, and ADR-018 says why: a vertical
           * drag inside a vertical scroll cannot be separated by axis, so
           * `DraggableList` separates it by **time** — 120 ms of holding still.
           * The scroll view sees a touch that has not moved and does nothing with
           * it; each list's detector is independent of the other's.
           */
          <DraggableList
            items={upcoming}
            keyOf={(song, index) => `${song.id}-${index}`}
            rowHeight={ROW_HEIGHT}
            onReorder={(from, to) => usePlayer.getState().reorderContextQueue(from, to)}
            renderItem={(song, index) => (
              /*
               * Removable too, since #572 — I asked for "swipe left to
               * remove, and little cross on every tracks", the same pair the
               * hand-queued list above has had since #379.
               *
               * The same `SwipeableRow` pointed the same way, which is what
               * ADR-018 means by reusing the composition answer rather than
               * tuning one per screen — and it is already proved against a
               * `DraggableList`, because the user queue does exactly this.
               *
               * ⚠️ It removes the track from **what plays next**, not from the
               * playlist or the library (I, 2026-08-17). The store edits
               * `contextOrder` and nothing else.
               */
              <SwipeableRow
                direction="left"
                tone="danger"
                label={t('queue.swipeRemove')}
                testId={`context-${song.id}-${index}`}
                onCommit={() => {
                  usePlayer.getState().removeFromContextQueue(index)
                  learnedSwipe()
                }}
              >
                <Pressable
                  // The point of the whole screen: this jumps ahead in the list
                  // you are already playing and leaves the hand-queued songs
                  // alone.
                  onPress={() => usePlayer.getState().skipToContext(index)}
                  accessibilityRole="button"
                  accessibilityLabel={t('queue.skipToAria', { title: song.title })}
                  style={({ pressed }) => (pressed ? styles.pressed : undefined)}
                >
                  <QueueRow
                    song={song}
                    styles={styles}
                    theme={theme}
                    onRemove={() => usePlayer.getState().removeFromContextQueue(index)}
                    removeLabel={t('queue.removeAria', { title: song.title })}
                  />
                </Pressable>
              </SwipeableRow>
            )}
          />
        )}

        <SleepTimerSheet visible={showSleep} onClose={() => setShowSleep(false)} />
      </ScrollView>
    </ScrollWindowProvider>
  )
}

/** One row: thumbnail · title · artist, plus whatever the caller adds. */
function QueueRow({
  song,
  styles,
  theme,
  highlighted = false,
  checked,
  onRemove,
  removeLabel,
}: {
  song: PlayableSong
  styles: ReturnType<typeof makeStyles>
  theme: Theme
  highlighted?: boolean
  checked?: boolean
  onRemove?: () => void
  removeLabel?: string
}) {
  return (
    <View style={styles.row}>
      {checked !== undefined ? (
        <View style={[styles.checkbox, checked && styles.checkboxOn]}>
          {checked ? <Text style={styles.checkmark}>✓</Text> : null}
        </View>
      ) : null}

      {song.cover_uri ? (
        <Image
          source={{ uri: song.cover_uri }}
          style={styles.thumbnail}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : (
        <View style={[styles.thumbnail, styles.thumbnailEmpty]}>
          <TabGlyph name="library" color={theme.textMuted} size={16} />
        </View>
      )}

      <View style={styles.rowText}>
        <Text style={[styles.title, highlighted && styles.current]} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {song.artist}
        </Text>
      </View>

      <Text style={styles.duration}>{formatDuration(song.duration)}</Text>

      {onRemove ? (
        <Button label={'×'} variant="plain" onPress={onRemove} accessibilityLabel={removeLabel} />
      ) : null}
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { paddingVertical: 12, paddingBottom: CONTAINER_PADDING_BOTTOM },
    controls: {
      flexDirection: 'row',
      gap: 8,
      flexWrap: 'wrap',
      paddingHorizontal: 16,
      paddingTop: 20,
    },
    headingRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      paddingRight: 16,
    },
    headingActions: { flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
    selectedCount: { fontSize: 12, color: theme.textMuted },
    heading: {
      fontSize: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: theme.textMuted,
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 4,
    },
    hint: { fontSize: 12, color: theme.textMuted, paddingHorizontal: 16, paddingBottom: 4 },
    empty: { fontSize: 13, color: theme.textMuted, paddingHorizontal: 16, paddingVertical: 8 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      gap: 12,
      height: ROW_HEIGHT,
    },
    pressed: { backgroundColor: theme.surfacePressed },
    thumbnail: { width: 40, height: 40, borderRadius: 5, backgroundColor: theme.surfaceMuted },
    thumbnailEmpty: { alignItems: 'center', justifyContent: 'center' },
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
    rowText: { flex: 1, minWidth: 0 },
    title: { fontSize: 15, fontWeight: '500', color: theme.text },
    current: { color: theme.accentOnSurface, fontWeight: '700' },
    artist: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
    duration: { fontSize: 12, color: theme.textMuted, fontVariant: ['tabular-nums'] },
    remove: { fontSize: 22, color: theme.textMuted, paddingHorizontal: 4 },
    link: { fontSize: 13, color: theme.accentOnSurface },
    linkDisabled: { opacity: 0.4 },
    destructive: { fontSize: 13, color: theme.danger },
  })
