import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../lib/cn'
import { useOnboardingStore } from '../onboarding/store'
import { OpeningAnimation } from './OpeningAnimation'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

/** The tour steps, in order. Each maps to `onboarding.<step>.{title,body}`. */
const STEPS = ['welcome', 'listen', 'add', 'personalize'] as const

/**
 * The first-run guided tour. App mounts it only while the tour is unfinished, so
 * it always starts at step 0 (and re-arms cleanly when replayed from Settings).
 */
export function OnboardingOverlay() {
  const { t } = useTranslation()
  const complete = useOnboardingStore((state) => state.complete)
  const [step, setStep] = useState(0)

  const key = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  return (
    <Modal open onClose={complete} labelledBy="onboarding-title" className="max-w-lg">
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <h2
            id="onboarding-title"
            className="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            {t(`onboarding.${key}.title`)}
          </h2>
          <button
            type="button"
            onClick={complete}
            className="text-sm text-slate-500 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {t('onboarding.skip')}
          </button>
        </div>

        {isFirst && <OpeningAnimation />}

        <p className="text-sm text-slate-600 dark:text-slate-300">{t(`onboarding.${key}.body`)}</p>

        <div className="flex justify-center gap-1.5" aria-hidden="true">
          {STEPS.map((name, index) => (
            <span
              key={name}
              className={cn(
                'h-1.5 rounded-full transition-all',
                index === step ? 'w-4 bg-accent-600' : 'w-1.5 bg-slate-300 dark:bg-slate-600',
              )}
            />
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStep((value) => value - 1)}
            disabled={isFirst}
          >
            {t('onboarding.back')}
          </Button>
          {isLast ? (
            <Button size="sm" onClick={complete}>
              {t('onboarding.getStarted')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setStep((value) => value + 1)}>
              {t('onboarding.next')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
