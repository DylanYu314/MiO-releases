import { useCallback, useState, type ReactNode } from 'react'

import { Button } from '../Button'
import { Modal } from '../Modal'
import { ConfirmContext, type ConfirmOptions } from './context'

interface Pending {
  options: ConfirmOptions
  resolve: (value: boolean) => void
}

/** Provides a promise-based `confirm(...)` that resolves true/false when the
 *  user answers a modal dialog — the accessible replacement for window.confirm. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => setPending({ options, resolve }))
  }, [])

  function settle(value: boolean) {
    setPending((current) => {
      current?.resolve(value)
      return null
    })
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal open={pending !== null} onClose={() => settle(false)} labelledBy="confirm-title">
        {pending && (
          <div className="space-y-4">
            <h2
              id="confirm-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              {pending.options.title}
            </h2>
            {pending.options.message && (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {pending.options.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => settle(false)}>
                {pending.options.cancelLabel ?? 'Cancel'}
              </Button>
              <Button
                variant={pending.options.danger ? 'danger' : 'primary'}
                onClick={() => settle(true)}
              >
                {pending.options.confirmLabel ?? 'Confirm'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}
