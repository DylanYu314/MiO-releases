import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-accent-500 focus:ring-2 focus:ring-accent-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:ring-accent-900',
        className,
      )}
    />
  )
}
