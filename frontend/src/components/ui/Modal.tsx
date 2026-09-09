import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../../lib/cn'

interface ModalProps {
  open: boolean
  onClose: () => void
  /** id of the element that titles the dialog, for aria-labelledby. */
  labelledBy?: string
  className?: string
  children: ReactNode
}

/** A centred, portalled dialog. Closes on Escape or an overlay click, locks
 *  body scroll while open, and moves focus into itself. A minimal focus
 *  treatment (not a full trap) — enough for the short confirm dialogs here. */
export function Modal({ open, onClose, labelledBy, className, children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          'relative z-10 w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl outline-none dark:border-slate-700 dark:bg-slate-800',
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
