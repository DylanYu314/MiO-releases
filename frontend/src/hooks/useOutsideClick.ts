import { useEffect, type RefObject } from 'react'

/** Call `onOutside` when a pointer press lands outside `ref`. Used by the
 *  dropdown menus to close on an outside click. */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  onOutside: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return
    function handle(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) onOutside()
    }
    document.addEventListener('pointerdown', handle)
    return () => document.removeEventListener('pointerdown', handle)
  }, [ref, onOutside, active])
}
