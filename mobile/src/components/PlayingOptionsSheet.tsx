import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PlayableSong } from '../api/types'
import { usePlayer } from '../player/store'
import { useSleepCountdown } from '../player/useSleepCountdown'
import { formatDuration } from '../api/songs'
import { ActionSheet, type SheetAction } from './ActionSheet'
import { SleepTimerSheet } from './SleepTimerSheet'
import { PlaylistPicker } from './PlaylistPicker'

interface Props {
  song: PlayableSong
  onClose: () => void
  onOpenQueue: () => void
}

/** Offered speeds. Capped at 2 because Android coerces past it (see `store.ts`). */
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]

/**
 * The playing-options half sheet (#232), raised from the panel's 3-dot.
 *
 * Distinct from the track-row menu on purpose. That one acts on *a row*; this
 * acts on **what is playing**, and carries the playback settings a row menu has
 * no business with — speed and the sleep timer belong to the session, not to a
 * song.
 *
 * ## Three sheets, not one screen
 *
 * Speed and the sleep timer are choices rather than actions, so each opens its
 * own `ActionSheet` instead of growing this one into a settings page. Reusing
 * the sheet three times keeps one dismissal behaviour, one look, and no new
 * modal component — and the Android three-button `Alert` ceiling that
 * `ActionSheet` exists to escape applies just as much to a list of six speeds.
 *
 * Only one is mounted at a time. `PlaylistPicker` in particular fetches the
 * playlist list on mount, so rendering it unconditionally would query on every
 * open of the panel.
 */
export function PlayingOptionsSheet({ song, onClose, onOpenQueue }: Props) {
  const { t } = useTranslation()
  const [view, setView] = useState<'main' | 'speed' | 'sleep'>('main')
  const [picking, setPicking] = useState(false)

  const playbackRate = usePlayer((state) => state.playbackRate)
  const sleepAfterTrack = usePlayer((state) => state.sleepAfterTrack)
  const countdown = useSleepCountdown()

  const close = () => {
    setView('main')
    onClose()
  }

  /**
   * What the sleep row says when a timer is already running.
   *
   * **The clock time it will stop at, not the minutes left.** A countdown needs
   * `Date.now()`, which is impure and produces a different label every time
   * React happens to re-render (`react-hooks/purity`) — and holding it in state
   * instead only moved the problem into an effect that derives state from props.
   *
   * The absolute time is a pure function of `sleepAt`, needs neither, and is the
   * better label anyway: "in 20 min" goes stale while the sheet is open, and
   * "Stopping at 23:15" does not.
   */
  const sleepSummary = () => {
    if (sleepAfterTrack) return t('player.sleepSetEndOfTrack')
    if (countdown === null) return undefined
    // A countdown rather than a clock reading (#314): the old label was a pure
    // function of `sleepAt` and so never moved, which is exactly why it was
    // written that way and exactly what was wrong with it.
    return t('player.sleepStoppingIn', { time: formatDuration(countdown) })
  }

  const mainActions: readonly SheetAction[] = [
    {
      key: 'queue',
      label: t('song.queue'),
      onPress: () => usePlayer.getState().addToQueue(song),
    },
    {
      key: 'add-to-playlist',
      // Same reason: the picker is rendered by this component.
      replacesSheet: true,
      label: t('song.addToPlaylist'),
      onPress: () => setPicking(true),
    },
    { key: 'open-queue', label: t('player.openQueue'), onPress: onOpenQueue },
    {
      key: 'speed',
      // `replacesSheet`, or the sheet's own close would unmount this component
      // before `setView` could run — the panel drops it on close.
      replacesSheet: true,
      label: `${t('player.speed')} · ${t('player.rate', { rate: playbackRate })}`,
      onPress: () => setView('speed'),
    },
    {
      key: 'sleep',
      replacesSheet: true,
      label: [t('player.sleepTimer'), sleepSummary()].filter(Boolean).join(' · '),
      onPress: () => setView('sleep'),
    },
  ]

  const speedActions: readonly SheetAction[] = SPEEDS.map((rate) => ({
    key: `speed-${rate}`,
    label: `${t('player.rate', { rate })}${rate === playbackRate ? '  ✓' : ''}`,
    onPress: () => usePlayer.getState().setPlaybackRate(rate),
  }))

  return (
    <>
      <ActionSheet
        visible={view === 'main' && !picking}
        title={song.title}
        subtitle={song.artist}
        artworkUri={song.cover_uri}
        actions={mainActions}
        onClose={close}
      />
      <ActionSheet
        visible={view === 'speed'}
        title={t('player.speed')}
        actions={speedActions}
        onClose={close}
      />
      <SleepTimerSheet visible={view === 'sleep'} onClose={close} />
      {picking ? (
        <PlaylistPicker
          songs={[song]}
          onClose={() => {
            setPicking(false)
            close()
          }}
        />
      ) : null}
    </>
  )
}
