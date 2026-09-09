import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      {...props}
      className={cn(
        'rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700 outline-none focus:border-accent-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200',
        className,
      )}
    />
  )
}
