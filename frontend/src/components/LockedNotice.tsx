import { useQueryClient } from '@tanstack/react-query'
import { Lock } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ACCESS_STATUS_KEY } from '../api/access'
import { setAccessKey } from '../api/accessKey'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

/** Shown in place of an import feature when the server has it locked and this
 *  device has no valid key (ADR-009). Entering a valid key unlocks it in place;
 *  the same field lives in Settings. */
export function LockedNotice() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    setAccessKey(trimmed)
    // Re-check with the server; a valid key flips `unlocked` and reveals the
    // feature, a bad one leaves this notice in place.
    queryClient.invalidateQueries({ queryKey: ACCESS_STATUS_KEY })
  }

  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
      <Lock className="mx-auto h-8 w-8 text-slate-400 dark:text-slate-500" aria-hidden />
      <h3 className="mt-3 font-semibold text-slate-900 dark:text-slate-100">{t('locked.title')}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
        {t('locked.description')}
      </p>
      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <Input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t('locked.placeholder')}
          aria-label={t('locked.title')}
          autoComplete="off"
          className="flex-1"
        />
        <Button type="submit">{t('locked.unlock')}</Button>
      </form>
    </div>
  )
}
