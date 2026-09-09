import { cn } from '../../lib/cn'

/** A pulsing placeholder for content that's still loading. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded bg-slate-200 motion-reduce:animate-none dark:bg-slate-700',
        className,
      )}
    />
  )
}
