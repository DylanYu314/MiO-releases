import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

export function Checkbox({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      type="checkbox"
      className={cn(
        'h-4 w-4 rounded border-slate-300 accent-accent-600 focus:ring-accent-500 dark:border-slate-600',
        className,
      )}
    />
  )
}
