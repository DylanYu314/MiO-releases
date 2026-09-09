import { Moon } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useOutsideClick } from '../hooks/useOutsideClick'
import { usePlayerStore } from '../player/store'

const MINUTE_OPTIONS = [15, 30, 45, 60]

export function SleepTimerMenu({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const sleepAt = usePlayerStore((state) => state.sleepAt)
  const sleepAfterTrack = usePlayerStore((state) => state.sleepAfterTrack)
  const setSleepTimer = usePlayerStore((state) => state.setSleepTimer)

  const active = sleepAt !== null || sleepAfterTrack

  // The label shows when playback stops, not how long is left. A countdown
  // would need the clock read during render (which react-hooks/purity forbids)
  // plus a ticking timer to stay honest; an absolute time is derived purely
  // from the stored deadline, and is less ambiguous to read anyway.
  useOutsideClick(containerRef, () => setOpen(false), open)

  function choose(option: number | 'endOfTrack' | null) {
    setSleepTimer(option)
    setOpen(false)
  }

  const stopTime =
    active && !sleepAfterTrack
      ? new Date(sleepAt!).toLocaleTimeString(i18n.language, {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null

  const label = active
    ? sleepAfterTrack
      ? t('sleep.activeEndOfTrack')
      : t('sleep.activeUntil', { time: stopTime })
    : t('sleep.title')

  // A bare moon icon sits in a row of ten other monochrome glyphs and reads as
  // decoration — the control was on screen but nobody could find it. A short
  // text label alongside the icon makes it a control, matching how the speed
  // selector shows "1x". When a timer is running the label becomes the stop
  // time, so the state is legible at a glance rather than only via the ring.
  const shortLabel = active
    ? sleepAfterTrack
      ? t('sleep.endOfTrackShort')
      : stopTime
    : t('sleep.short')

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={active}
        aria-label={label}
        title={label}
        className={`flex items-center gap-1 rounded p-2 transition ${
          active
            ? 'bg-accent-100 text-accent-700 ring-1 ring-accent-300 dark:bg-accent-950 dark:text-accent-300 dark:ring-accent-700'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
        }`}
      >
        <Moon className="h-4 w-4 shrink-0" aria-hidden />
        {/* Hidden from assistive tech: the button's aria-label already says all
            of this, and more precisely. Narrow screens keep the icon alone.
            The breakpoint is md, not sm: the bar's control row already overflows
            its container between 640px and ~768px (measured: 637px of content
            in 628px at 660px wide, before this label existed), so widening a
            control there would deepen an existing clip. */}
        <span aria-hidden className="hidden text-xs tabular-nums md:inline">
          {shortLabel}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-20 mb-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-600 dark:bg-slate-800"
        >
          {MINUTE_OPTIONS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              role="menuitem"
              onClick={() => choose(minutes)}
              className="block w-full px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {t('sleep.minutes', { count: minutes })}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            onClick={() => choose('endOfTrack')}
            className="block w-full px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {t('sleep.endOfTrack')}
          </button>
          {active && (
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(null)}
              className="block w-full border-t border-slate-200 px-3 py-2 text-left text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-slate-600 dark:text-red-400 dark:hover:bg-red-950"
            >
              {t('sleep.cancel')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
