import { useTranslation } from 'react-i18next'

import { cn } from '../lib/cn'
import { EQ_BANDS, EQ_MAX_GAIN_DB, type ChannelMode } from '../player/audioGraph'
import {
  EQ_PRESETS,
  selectIsNeutral,
  useAudioSettingsStore,
  type EqPresetName,
} from '../player/audioSettings'
import { Button, Card } from './ui'

const PRESETS = Object.keys(EQ_PRESETS) as EqPresetName[]
const CHANNEL_MODES: ChannelMode[] = ['stereo', 'mono']

/** 31 -> "31", 16000 -> "16k" — a slider label has room for neither Hz nor
 *  four digits. */
function bandLabel(frequency: number) {
  return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)
}

export function EqualizerCard() {
  const { t } = useTranslation()

  const eqGains = useAudioSettingsStore((state) => state.eqGains)
  const preset = useAudioSettingsStore((state) => state.preset)
  const channelMode = useAudioSettingsStore((state) => state.channelMode)
  const balance = useAudioSettingsStore((state) => state.balance)
  const isNeutral = useAudioSettingsStore(selectIsNeutral)

  const setBandGain = useAudioSettingsStore((state) => state.setBandGain)
  const applyPreset = useAudioSettingsStore((state) => state.applyPreset)
  const resetEq = useAudioSettingsStore((state) => state.resetEq)
  const setChannelMode = useAudioSettingsStore((state) => state.setChannelMode)
  const setBalance = useAudioSettingsStore((state) => state.setBalance)
  const normalizeLoudness = useAudioSettingsStore((state) => state.normalizeLoudness)
  const setNormalizeLoudness = useAudioSettingsStore((state) => state.setNormalizeLoudness)

  const balanceLabel =
    balance === 0
      ? t('equalizer.balanceCentre')
      : balance < 0
        ? t('equalizer.balanceLeft', { percent: Math.round(-balance * 100) })
        : t('equalizer.balanceRight', { percent: Math.round(balance * 100) })

  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('equalizer.title')}</h3>
        {/* Says plainly that nothing is being applied, rather than leaving the
            listener to infer it from ten sliders sitting at zero. */}
        <span className="text-sm text-slate-500 dark:text-slate-400">
          {isNeutral ? t('equalizer.neutral') : t('equalizer.active')}
        </span>
      </div>

      <div className="space-y-2">
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('equalizer.preset')}</p>
        <div role="radiogroup" aria-label={t('equalizer.preset')} className="flex flex-wrap gap-2">
          {PRESETS.map((name) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={preset === name}
              onClick={() => applyPreset(name)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                preset === name
                  ? 'bg-accent-600 text-white'
                  : 'border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700',
              )}
            >
              {t(`equalizer.presets.${name}`)}
            </button>
          ))}
          {preset === null && (
            <span className="self-center rounded-lg border border-dashed border-slate-300 px-3 py-1.5 text-sm text-slate-500 dark:border-slate-600 dark:text-slate-400">
              {t('equalizer.presets.custom')}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-end justify-between gap-1 sm:gap-2">
        {EQ_BANDS.map((frequency, index) => {
          const gain = eqGains[index] ?? 0
          return (
            <div key={frequency} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <span className="text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                {gain > 0 ? `+${gain}` : gain}
              </span>
              {/* Rotated so the control reads the way a mixing desk does: up is
                  a boost. A horizontal slider for "gain" is a coin-flip. */}
              <input
                type="range"
                min={-EQ_MAX_GAIN_DB}
                max={EQ_MAX_GAIN_DB}
                step={1}
                value={gain}
                onChange={(event) => setBandGain(index, Number(event.target.value))}
                aria-label={t('equalizer.bandAria', { frequency: bandLabel(frequency) })}
                className="h-24 w-6 accent-accent-600"
                style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
              />
              <span className="text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
                {bandLabel(frequency)}
              </span>
            </div>
          )
        })}
      </div>

      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={resetEq}>
          {t('equalizer.reset')}
        </Button>
      </div>

      <div className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-700">
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('equalizer.channel')}</p>
        <div role="radiogroup" aria-label={t('equalizer.channel')} className="flex gap-2">
          {CHANNEL_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={channelMode === mode}
              onClick={() => setChannelMode(mode)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm font-medium transition',
                channelMode === mode
                  ? 'bg-accent-600 text-white'
                  : 'border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700',
              )}
            >
              {t(`equalizer.channelModes.${mode}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4 dark:border-slate-700">
        <div className="min-w-0">
          <label
            htmlFor="normalize"
            className="text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            {t('equalizer.normalize')}
          </label>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {t('equalizer.normalizeDescription')}
          </p>
        </div>
        <input
          id="normalize"
          type="checkbox"
          checked={normalizeLoudness}
          onChange={(event) => setNormalizeLoudness(event.target.checked)}
          className="h-4 w-4 shrink-0 accent-accent-600"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <label
            htmlFor="balance"
            className="text-sm font-medium text-slate-700 dark:text-slate-200"
          >
            {t('equalizer.balance')}
          </label>
          <span className="text-sm tabular-nums text-slate-600 dark:text-slate-300">
            {balanceLabel}
          </span>
        </div>
        <input
          id="balance"
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={balance}
          onChange={(event) => setBalance(Number(event.target.value))}
          className="w-full accent-accent-600"
        />
      </div>
    </Card>
  )
}
