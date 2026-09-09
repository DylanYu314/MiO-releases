import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '../../../lib/cn'
import { ToastContext, type ToastType } from './context'
import { X } from 'lucide-react'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const AUTO_DISMISS_MS = 5000

const TONES: Record<ToastType, string> = {
  success:
    'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-300',
  error:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400',
  info: 'border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
}

let nextId = 0

/** Holds a stack of transient messages and renders them in a fixed corner.
 *  Additive to the inline role="alert" messages components already show. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = nextId++
      setToasts((current) => [...current, { id, message, type }])
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fixed bottom-20 right-4 z-50 flex w-72 flex-col gap-2">
        {toasts.map((item) => (
          <div
            key={item.id}
            role={item.type === 'error' ? 'alert' : 'status'}
            className={cn(
              'flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm shadow-lg',
              TONES[item.type],
            )}
          >
            <span>{item.message}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label={t('common.dismiss')}
              className="shrink-0 opacity-60 transition hover:opacity-100"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
