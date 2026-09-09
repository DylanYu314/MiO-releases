import { useCallback, useMemo, useState } from 'react'

/**
 * Choosing several songs at once, on a list you are already looking at (#336).
 *
 * *"I generally want a group select feature in library and playlist page
 * to manage tracks and playlists."* Everything before this was one at a time —
 * removing ten tracks was ten journeys through the same sheet.
 *
 * ## Why this is a hook and not another picker
 *
 * `SongPicker` and `PlaylistPicker` are already multi-select lists, and the
 * standing rule is to reuse rather than rebuild. They are the wrong shape here
 * all the same, and the difference is which list you are looking at: a picker
 * is a **modal over a list you are not on**, opened to choose things to bring
 * somewhere else. This is the same interaction turned inwards — the list is
 * already on screen, and it is the one being acted on.
 *
 * So what is shared is the *state machine*, which is this file, and both
 * screens draw it with the components they already have.
 *
 * ## How selection starts
 *
 * An explicit **Select** button, which is my instruction and also what the
 * issue argued for. Long-press is taken twice over — "open the sheet" on a song
 * row, "start dragging" on a playlist (#233, 120 ms) — and a third meaning for
 * one gesture is a conflict rather than a shortcut.
 *
 * ## Ids, not songs
 *
 * The set holds ids, so a list that refetches underneath does not strand a
 * selection against stale objects. It is also why {@link prune} exists: after a
 * removal the ids that no longer exist have to go, or the count keeps promising
 * songs that are not there.
 */
export interface Selection {
  /** Whether the list is in selection mode at all. */
  active: boolean
  /** The chosen ids. Empty is a normal state — selection mode opens that way. */
  ids: ReadonlySet<string>
  count: number
  /** Enter selection mode, with nothing chosen. */
  begin: () => void
  /** Leave it, forgetting what was chosen. */
  end: () => void
  toggle: (id: string) => void
  /** Choose everything, or clear if everything already is. */
  toggleAll: (ids: readonly string[]) => void
  /** Drop ids that no longer exist, after the list changed underneath. */
  prune: (ids: readonly string[]) => void
  /** `selected` for a row: a boolean while selecting, `undefined` otherwise —
   *  which is exactly what `SongRow` reads as "not selectable". */
  stateFor: (id: string) => boolean | undefined
}

export function useSelection(): Selection {
  const [active, setActive] = useState(false)
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())

  const begin = useCallback(() => {
    setActive(true)
    setIds(new Set())
  }, [])

  const end = useCallback(() => {
    setActive(false)
    // Cleared on the way out rather than on the way in as well, so re-entering
    // never inherits a selection the user cannot see.
    setIds(new Set())
  }, [])

  const toggle = useCallback((id: string) => {
    setIds((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback((all: readonly string[]) => {
    setIds((current) => (current.size === all.length ? new Set() : new Set(all)))
  }, [])

  const prune = useCallback((existing: readonly string[]) => {
    const keep = new Set(existing)
    setIds((current) => {
      // Returning the same set when nothing changed keeps this out of the
      // render loop: a new Set every time a list settles would re-render every
      // row for no reason, and the list this runs on can be hundreds long.
      let changed = false
      const next = new Set<string>()
      for (const id of current) {
        if (keep.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : current
    })
  }, [])

  const stateFor = useCallback((id: string) => (active ? ids.has(id) : undefined), [active, ids])

  return useMemo(
    () => ({
      active,
      ids,
      count: ids.size,
      begin,
      end,
      toggle,
      toggleAll,
      prune,
      stateFor,
    }),
    [active, ids, begin, end, toggle, toggleAll, prune, stateFor],
  )
}
