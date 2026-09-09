import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { ACCESS_STATUS_KEY } from '../api/access'
import { getAccessKey, setAccessKey } from '../api/accessKey'
import { EqualizerCard } from '../components/EqualizerCard'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { Button, Card, Input } from '../components/ui'
import { useToast } from '../components/ui/toast/context'
import { cn } from '../lib/cn'
import { useOnboardingStore } from '../onboarding/store'
import { CROSSFADE_MAX_SECONDS, usePlayerStore } from '../player/store'
import { ACCENT_PRESETS, useThemeStore, type AccentName, type ThemeMode } from '../theme/store'

const MODES: ThemeMode[] = ['system', 'light', 'dark']

export function SettingsPage() {
  const { t } = useTranslation()
  const mode = useThemeStore((state) => state.mode)
  const accent = useThemeStore((state) => state.accent)
  const setMode = useThemeStore((state) => state.setMode)
  const setAccent = useThemeStore((state) => state.setAccent)
  const replayTour = useOnboardingStore((state) => state.reset)

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
        {t('settings.title')}
      </h2>

      <Card className="space-y-5">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">
          {t('settings.appearance')}
        </h3>

        <div className="space-y-2">
          <p className="text-sm text-slate-600 dark:text-slate-300">{t('settings.theme')}</p>
          <div role="radiogroup" aria-label={t('settings.theme')} className="flex gap-2">
            {MODES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                  mode === value
                    ? 'bg-accent-600 text-white'
                    : 'border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700',
                )}
              >
                {t(`settings.mode.${value}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-slate-600 dark:text-slate-300">{t('settings.accent')}</p>
          <div className="flex flex-wrap gap-2">
            {Object.entries(ACCENT_PRESETS).map(([key, preset]) => (
              <button
                key={key}
                type="button"
                aria-label={preset.label}
                aria-pressed={accent === key}
                onClick={() => setAccent(key as AccentName)}
                className={cn(
                  'h-8 w-8 rounded-full ring-2 ring-offset-2 transition ring-offset-white dark:ring-offset-slate-800',
                  accent === key ? 'ring-slate-900 dark:ring-white' : 'ring-transparent',
                )}
                style={{ backgroundColor: preset.ramp[6] }}
              />
            ))}
          </div>
        </div>
      </Card>

      <PlaybackCard />

      <EqualizerCard />

      <Card className="space-y-3">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">
          {t('settings.language')}
        </h3>
        <LanguageSwitcher />
      </Card>

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('settings.tour')}</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {t('settings.tourDescription')}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={replayTour}>
          {t('settings.showTour')}
        </Button>
      </Card>

      <AccessKeyCard />

      {/* Last, and reached from here rather than the nav bar: it is for the
          session where something has gone wrong (#322). */}
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">
            {t('diagnostics.title')}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {t('diagnostics.settingsHint')}
          </p>
        </div>
        <Link
          to="/diagnostics"
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          {t('diagnostics.open')}
        </Link>
      </Card>
    </div>
  )
}

function PlaybackCard() {
  const { t } = useTranslation()
  const crossfadeSeconds = usePlayerStore((state) => state.crossfadeSeconds)
  const setCrossfadeSeconds = usePlayerStore((state) => state.setCrossfadeSeconds)

  const valueLabel =
    crossfadeSeconds === 0
      ? t('playback.crossfadeOff')
      : t('playback.crossfadeSeconds', { count: crossfadeSeconds })

  return (
    <Card className="space-y-3">
      <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('playback.title')}</h3>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <label
            htmlFor="crossfade"
            className="text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            {t('playback.crossfade')}
          </label>
          {/* The value has to be visible: a slider whose only feedback is its
              own position tells you nothing about what 7 seconds means. */}
          <span className="text-sm tabular-nums text-slate-600 dark:text-slate-300">
            {valueLabel}
          </span>
        </div>
        <input
          id="crossfade"
          type="range"
          min={0}
          max={CROSSFADE_MAX_SECONDS}
          step={1}
          value={crossfadeSeconds}
          onChange={(event) => setCrossfadeSeconds(Number(event.target.value))}
          className="w-full accent-accent-600"
        />
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('playback.crossfadeDescription')}
        </p>
      </div>
    </Card>
  )
}

function AccessKeyCard() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const [value, setValue] = useState(() => getAccessKey())

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setAccessKey(value)
    // Re-check the gate so a locked import unlocks (or re-locks) immediately.
    queryClient.invalidateQueries({ queryKey: ACCESS_STATUS_KEY })
    toast(value.trim() ? t('accessKey.saved') : t('accessKey.cleared'), 'success')
  }

  return (
    <Card className="space-y-3">
      <div>
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('accessKey.title')}</h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          {t('accessKey.description')}
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('accessKey.placeholder')}
          aria-label={t('accessKey.title')}
          autoComplete="off"
          className="flex-1"
        />
        <Button type="submit" variant="secondary">
          {t('accessKey.save')}
        </Button>
      </form>
    </Card>
  )
}
