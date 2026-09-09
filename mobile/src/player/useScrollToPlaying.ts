import { useCallback, useEffect, useRef } from 'react'
import type { FlatList } from 'react-native'

/**
 * Scroll a list to the track that is playing, once, when it opens (#239).
 *
 * Opening the library or a playlist that contains what is playing and being
 * shown the top of the list is a small thing that happens constantly: the answer
 * to "what is this?" is always one manual scroll away.
 *
 * ## Once per mount, and never a jump
 *
 * The scroll is armed once and disarmed the moment it fires. That matters more
 * than it looks: `current` changes every time a track advances, and a list that
 * re-centred on every change would yank itself out from under a finger that is
 * scrolling — which is worse than never scrolling at all.
 *
 * It also fires only when there is somewhere to go. **A track that is not in
 * this list scrolls nothing**, which is the other half of what #239 asks for:
 * a playlist that does not contain the playing song must open at the top like
 * any other, not at some nearest-guess position.
 *
 * The one-shot is armed until *both* the list has content and something is
 * playing, because neither is true on the first render — the list is an async
 * read and the player store rehydrates from AsyncStorage. Waiting for both is
 * what makes this work on a cold start, which is the case it exists for. The
 * consequence, accepted: starting a track from this list later in the same mount
 * will centre it. The row was under the finger that started it, so the movement
 * is small, and it can only happen once.
 *
 * ## Why `getItemLayout` comes with it
 *
 * `scrollToIndex` cannot reach a row `FlatList` has never rendered — it does not
 * know how far down it is. `getItemLayout` answers that without measuring, which
 * is only possible because `SongRow` is a fixed height. The hook returns it
 * rather than leaving each caller to write it, so the row height and the scroll
 * cannot drift apart.
 */
export function useScrollToPlaying<T>(
  items: readonly T[],
  idOf: (item: T) => string | number,
  currentId: string | number | null,
  /** Row height *including* whatever separator sits under it. */
  itemHeight: number,
) {
  const listRef = useRef<FlatList<T>>(null)
  const done = useRef(false)

  useEffect(() => {
    if (done.current) return
    // Nothing to scroll, or nothing to scroll to — stay armed and try again
    // when the reads land.
    if (items.length === 0 || currentId === null) return

    done.current = true

    const index = items.findIndex((item) => idOf(item) === currentId)
    // Not in this list, or already the first row: both mean "leave it alone".
    if (index <= 0) return

    listRef.current?.scrollToIndex({
      index,
      animated: false,
      // Centred rather than pinned to the top, so the tracks either side are
      // visible and the position reads as "here" instead of "the start".
      viewPosition: 0.5,
    })
  }, [items, idOf, currentId])

  const getItemLayout = useCallback(
    (_data: ArrayLike<T> | null | undefined, index: number) => ({
      length: itemHeight,
      offset: itemHeight * index,
      index,
    }),
    [itemHeight],
  )

  return { listRef, getItemLayout }
}
