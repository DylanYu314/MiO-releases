import { useCallback, useMemo, useState } from 'react'

/** Tracks a set of selected ids for multi-select UIs. Generic over the id type
 *  so it works for match ids, song ids, etc. Callers scope it (e.g. clear it on
 *  page/filter change) — the hook only owns the set. */
export function useSelection<T>() {
  const [selected, setSelected] = useState<ReadonlySet<T>>(() => new Set())

  const toggle = useCallback((id: T) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const set = useCallback((ids: readonly T[]) => setSelected(new Set(ids)), [])
  const clear = useCallback(() => setSelected(new Set()), [])
  const isSelected = useCallback((id: T) => selected.has(id), [selected])

  return useMemo(
    () => ({ selected, ids: [...selected], count: selected.size, toggle, set, clear, isSelected }),
    [selected, toggle, set, clear, isSelected],
  )
}
