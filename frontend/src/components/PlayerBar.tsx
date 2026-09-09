import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { songCoverUrl } from '../api/songs'
import { formatDuration } from '../lib/format'
import { selectCurrentSong, selectHasNext, usePlayerStore } from '../player/store'
import { useAudioElement } from '../player/useAudioElement'
import { QueuePanel } from './QueuePanel'
import { SleepTimerMenu } from './SleepTimerMenu'
import {
  ListMusic,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  RotateCw,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react'

const controlClass =
  'rounded p-2 text-slate-600 transition hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-slate-700'

/** A toggle that is currently on. Tinting the icon alone reads as decoration —
 *  a filled, ringed control is what makes "this is switched on" legible. */
const activeToggleClass =
  'rounded p-2 transition bg-accent-100 text-accent-700 ring-1 ring-accent-300 hover:bg-accent-200 dark:bg-accent-950 dark:text-accent-300 dark:ring-accent-700 dark:hover:bg-accent-900'

const SKIP_SECONDS = 15
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export function PlayerBar() {
  const { t } = useTranslation()
  const [queueOpen, setQueueOpen] = useState(false)
  const { audioRef, currentTime, duration, seek } = useAudioElement()

  const currentSong = usePlayerStore(selectCurrentSong)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const shuffle = usePlayerStore((state) => state.shuffle)
  const repeat = usePlayerStore((state) => state.repeat)
  const volume = usePlayerStore((state) => state.volume)
  const muted = usePlayerStore((state) => state.muted)
  const hasNext = usePlayerStore(selectHasNext)
  const queuedCount = usePlayerStore((state) => state.userQueue.length)
  const playbackRate = usePlayerStore((state) => state.playbackRate)

  const togglePlay = usePlayerStore((state) => state.togglePlay)
  const next = usePlayerStore((state) => state.next)
  const previous = usePlayerStore((state) => state.previous)
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle)
  const cycleRepeat = usePlayerStore((state) => state.cycleRepeat)
  const setVolume = usePlayerStore((state) => state.setVolume)
  const toggleMute = usePlayerStore((state) => state.toggleMute)
  const setPlaybackRate = usePlayerStore((state) => state.setPlaybackRate)

  // Prefer the element's real duration, falling back to the stored metadata
  // before the audio has loaded.
  const total = duration || currentSong?.duration || 0

  function skipBy(seconds: number) {
    seek(Math.min(Math.max(currentTime + seconds, 0), total || currentTime))
  }

  return (
    <>
      {/*
        Rendered unconditionally, at a fixed position in the tree, for two
        reasons: playback has to survive navigation, and the Web Audio graph
        (ADR-012) binds this element *permanently* — one element, one context,
        forever. Returning it bare in one branch and nested in another made
        React unmount and recreate it the moment the first song started, which
        was harmless before the graph and would silently kill audio now.
      */}
      <audio ref={audioRef} hidden />

      {currentSong && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
          <div className="mx-auto flex max-w-4xl flex-col gap-2 px-4 py-3">
            <div className="flex items-center gap-3" data-testid="player-bar-controls">
              <img
                src={songCoverUrl(currentSong.id)}
                alt=""
                className="h-11 w-11 shrink-0 rounded object-cover"
                onError={(event) => {
                  event.currentTarget.style.visibility = 'hidden'
                }}
              />

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {currentSong.title}
                </p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {currentSong.artist}
                </p>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={toggleShuffle}
                  aria-pressed={shuffle}
                  aria-label={t('player.shuffle')}
                  title={t('player.shuffle')}
                  className={shuffle ? activeToggleClass : controlClass}
                >
                  <Shuffle className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={previous}
                  aria-label={t('player.previous')}
                  className={controlClass}
                >
                  <SkipBack className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => skipBy(-SKIP_SECONDS)}
                  aria-label={t('player.skipBack', { seconds: SKIP_SECONDS })}
                  title={t('player.skipBack', { seconds: SKIP_SECONDS })}
                  className={`${controlClass} hidden sm:inline-flex`}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={isPlaying ? t('player.pause') : t('player.play')}
                  className="rounded-full bg-accent-600 px-3 py-2 text-white transition hover:bg-accent-700"
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4" aria-hidden />
                  ) : (
                    <Play className="h-4 w-4" aria-hidden />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => skipBy(SKIP_SECONDS)}
                  aria-label={t('player.skipForward', { seconds: SKIP_SECONDS })}
                  title={t('player.skipForward', { seconds: SKIP_SECONDS })}
                  className={`${controlClass} hidden sm:inline-flex`}
                >
                  <RotateCw className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={next}
                  disabled={!hasNext}
                  aria-label={t('player.next')}
                  className={controlClass}
                >
                  <SkipForward className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={cycleRepeat}
                  aria-pressed={repeat !== 'off'}
                  aria-label={t('player.repeatAria', { mode: t(`player.repeatMode.${repeat}`) })}
                  title={t('player.repeatAria', { mode: t(`player.repeatMode.${repeat}`) })}
                  className={repeat !== 'off' ? activeToggleClass : controlClass}
                >
                  {repeat === 'one' ? (
                    <Repeat1 className="h-4 w-4" aria-hidden />
                  ) : (
                    <Repeat className="h-4 w-4" aria-hidden />
                  )}
                </button>
              </div>

              <select
                value={playbackRate}
                onChange={(event) => setPlaybackRate(Number(event.target.value))}
                aria-label={t('player.speed')}
                title={t('player.speed')}
                className={`hidden rounded border-0 bg-transparent py-1 pl-1 pr-5 text-xs tabular-nums transition hover:bg-slate-100 sm:block dark:hover:bg-slate-700 ${
                  playbackRate === 1
                    ? 'text-slate-600 dark:text-slate-300'
                    : 'font-semibold text-accent-700 dark:text-accent-300'
                }`}
              >
                {PLAYBACK_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {t('player.rate', { rate })}
                  </option>
                ))}
              </select>

              <SleepTimerMenu />

              <button
                type="button"
                onClick={() => setQueueOpen(true)}
                aria-label={t('queue.open')}
                className={`${controlClass} relative`}
              >
                <ListMusic className="h-4 w-4" aria-hidden />
                {queuedCount > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent-600 px-1 text-[10px] font-medium leading-4 text-white">
                    {queuedCount}
                  </span>
                )}
              </button>

              {/*
               * #126: this appeared at `sm` (640px) along with the seek buttons
               * and the rate select — about 240px arriving at once, at the width
               * with the least room for it. Measured overflowing at 640px and
               * 660px and fitting from 700px.
               *
               * Volume is the widest of the three (~124px with the slider) and
               * the easiest to do without on a narrow screen, where the device
               * has its own volume control. So its threshold moves to `md`
               * rather than the row being made to scroll or wrap: it was
               * already hidden below 640px, and this only moves that line to
               * where the row actually fits.
               */}
              <div className="hidden items-center gap-2 md:flex">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={muted ? t('player.unmute') : t('player.mute')}
                  className={controlClass}
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="h-4 w-4" aria-hidden />
                  ) : (
                    <Volume2 className="h-4 w-4" aria-hidden />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={(event) => setVolume(Number(event.target.value))}
                  aria-label={t('player.volume')}
                  className="w-20 accent-accent-600"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 text-xs tabular-nums text-slate-500 dark:text-slate-400">
              <span>{formatDuration(currentTime)}</span>
              <input
                type="range"
                min={0}
                max={total || 0}
                step={0.1}
                value={Math.min(currentTime, total || 0)}
                onChange={(event) => seek(Number(event.target.value))}
                aria-label={t('player.seek')}
                className="flex-1 accent-accent-600"
              />
              <span>{formatDuration(total || null)}</span>
            </div>
          </div>

          <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
        </div>
      )}
    </>
  )
}
