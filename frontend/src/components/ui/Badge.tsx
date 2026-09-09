import type { ComponentProps } from 'react'

import { cn } from '../../lib/cn'

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent'

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  success: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  accent: 'bg-accent-100 text-accent-800 dark:bg-accent-950 dark:text-accent-300',
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: Tone }) {
  return (
    <span
      {...props}
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
    />
  )
}
