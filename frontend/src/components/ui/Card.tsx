import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

/** A surface: bordered, padded, theme-aware. */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      {...props}
      className={cn(
        'rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800',
        className,
      )}
    />
  )
}
