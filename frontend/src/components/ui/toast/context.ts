import { createContext, useContext } from 'react'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastHandle {
  toast: (message: string, type?: ToastType) => void
}

export const ToastContext = createContext<ToastHandle | null>(null)

export function useToast(): ToastHandle {
  const handle = useContext(ToastContext)
  if (!handle) throw new Error('useToast must be used within a ToastProvider')
  return handle
}
