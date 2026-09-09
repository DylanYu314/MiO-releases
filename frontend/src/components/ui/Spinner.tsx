import { cn } from '../../lib/cn'

/** An indeterminate loading spinner. Inherits `currentColor`, so it takes the
 *  colour of whatever it sits in. Honours `prefers-reduced-motion`. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('h-4 w-4 animate-spin motion-reduce:animate-none', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  )
}
