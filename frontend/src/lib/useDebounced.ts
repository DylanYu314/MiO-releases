import { useEffect, useState } from 'react'

/** Returns `value` only after it has stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    // Cancel on every change, so the timer only fires once typing pauses.
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
