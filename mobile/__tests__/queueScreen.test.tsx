import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import type { ReactNode } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import QueueScreen from '../app/queue'
import type { Song } from '../src/api/types'
import { upNext, usePlayer } from '../src/player/store'
import '../src/i18n'

/**
 * The queue screen's job is to make the two tiers legible: what was queued by
 * hand versus what came from the list being played. Showing them as one list
 * would hide the very distinction the two-tier model exists to provide.
 *
 * ## The wrapper is not boilerplate
 *
 * `GestureDetector` throws outright without a `GestureHandlerRootView` above it
 * — "otherwise the gestures will not be recognized" — which is the same reason
 * the real app gained one in `_layout.tsx` (#233). Rendering the screen bare
 * here reproduced that error exactly, which is a pleasant way to find out the
 * root view was genuinely needed rather than cargo-culted.
 */
function wrapper({ children }: { children: ReactNode }) {
  return <GestureHandlerRootView>{children}</GestureHandlerRootView>
}

function song(id: number, title = `Song ${id}`): Song {
  return {
    id,
    title,
    artist: `Artist ${id}`,
    album: null,
    duration: 200,
    source_url: `https://example.com/${id}`,
    source_platform: 'youtube',
    added_at: '2026-07-25T00:00:00Z',
    loudness_lufs: null,
    peak_dbfs: null,
  }
}

const LIBRARY = [song(1), song(2), song(3)]

beforeEach(() => {
  usePlayer.setState({
    context: null,
    contextQueue: [],
    contextOrder: [],
    contextIndex: -1,
    userQueue: [],
    current: null,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    restartNonce: 0,
  })
})

describe('QueueScreen', () => {
  it('says nothing is playing before anything has started', async () => {
    await render(<QueueScreen />, { wrapper })

    expect(screen.getByText('Nothing is playing.')).toBeTruthy()
  })

  it('separates hand-queued songs from what is left of the list', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
      usePlayer.getState().addToQueue(song(50, 'Queued by hand'))
    })

    await render(<QueueScreen />, { wrapper })

    expect(screen.getByText('Now playing')).toBeTruthy()
    expect(screen.getByText('Song 1')).toBeTruthy()
    expect(screen.getByText('Queued by hand')).toBeTruthy()
    // Up next is the rest of the context, not the whole list again.
    expect(screen.getByText('Song 2')).toBeTruthy()
    expect(screen.getByText('Song 3')).toBeTruthy()
  })

  it('names where the list came from, so "up next" is not a mystery', async () => {
    await act(async () => {
      usePlayer
        .getState()
        .playFromContext(LIBRARY, 0, { kind: 'playlist', id: 4, name: 'Road Trip' })
    })

    await render(<QueueScreen />, { wrapper })

    expect(screen.getByText('Next from: Road Trip')).toBeTruthy()
  })

  it('offers the empty-queue hint that says how to fill it', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
    })

    await render(<QueueScreen />, { wrapper })

    expect(screen.getByText(/Nothing queued by hand/)).toBeTruthy()
  })

  /**
   * Swipe left to remove (#379), the mirror of the library's swipe-right to
   * queue. Driven through `fireGestureHandler` rather than synthesised touches,
   * per ADR-018 — the old scrubber test invented the very coordinate the
   * component was reading wrongly and stayed green while the feature was broken.
   */
  it('removes a queued song when the row is swiped left far enough', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
      usePlayer.getState().addToQueue(song(50, 'Queued by hand'))
      usePlayer.getState().addToQueue(song(51, 'Also queued'))
    })

    await render(<QueueScreen />, { wrapper })

    fireGestureHandler(getByGestureTestId('swipe-queue-50-0'), [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: -120 },
      { state: State.END, translationX: -120 },
    ])
    await act(async () => {})

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([51])
  })

  it('removes an upcoming context track when its row is swiped left (#572)', async () => {
    /*
     * I asked for the same pair the hand-queued list has had since #379 —
     * *"swipe left to remove, and little cross on every tracks"* — on the
     * context queue, which had neither.
     *
     * ⚠️ It removes the track from **what plays next**, never from the playlist
     * or the library. The store assertion below is the one that says so.
     */
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
    })

    await render(<QueueScreen />, { wrapper })
    const before = usePlayer.getState().contextQueue.map((s) => s.id)

    fireGestureHandler(getByGestureTestId(`swipe-context-${LIBRARY[1].id}-0`), [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: -120 },
      { state: State.END, translationX: -120 },
    ])
    await act(async () => {})

    const state = usePlayer.getState()
    expect(
      upNext(state.contextQueue, state.contextOrder, state.contextIndex).map((s) => s.id),
    ).not.toContain(LIBRARY[1].id)
    // The list itself is untouched — the song is still in the playlist it came
    // from, and shuffle is still undoable.
    expect(state.contextQueue.map((s) => s.id)).toEqual(before)
    // And the track playing is not the one that was removed from ahead of it.
    expect(state.current?.song.id).toBe(LIBRARY[0].id)
  })

  it('removes an upcoming context track from its cross, not only its swipe', async () => {
    // A gesture is a shortcut for people who know it exists, never the only way
    // to do something — #377's UI 9, and I asked for both explicitly.
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
    })

    await render(<QueueScreen />, { wrapper })

    await act(async () => {
      fireEvent.press(screen.getByLabelText(`Remove ${LIBRARY[1].title} from the queue`))
    })

    const state = usePlayer.getState()
    expect(
      upNext(state.contextQueue, state.contextOrder, state.contextIndex).map((s) => s.id),
    ).not.toContain(LIBRARY[1].id)
  })

  it('keeps a song that was not swiped far enough', async () => {
    // A wobble during a scroll is not a removal — and this is the assertion
    // that stops the test above passing against a row that removes on contact.
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
      usePlayer.getState().addToQueue(song(50, 'Queued by hand'))
    })

    await render(<QueueScreen />, { wrapper })

    fireGestureHandler(getByGestureTestId('swipe-queue-50-0'), [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: -40 },
      { state: State.END, translationX: -40 },
    ])
    await act(async () => {})

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([50])
  })

  it('does not remove on a rightward swipe, which is not what this row offers', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
      usePlayer.getState().addToQueue(song(50, 'Queued by hand'))
    })

    await render(<QueueScreen />, { wrapper })

    fireGestureHandler(getByGestureTestId('swipe-queue-50-0'), [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: 200 },
      { state: State.END, translationX: 200 },
    ])
    await act(async () => {})

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([50])
  })

  it('removes a queued song when its × is pressed', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
      usePlayer.getState().addToQueue(song(50, 'Queued by hand'))
      usePlayer.getState().addToQueue(song(51, 'Also queued'))
    })

    await render(<QueueScreen />, { wrapper })
    // Found by accessibility label rather than a test id, so the test only
    // passes if a user could actually reach the control.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Remove Queued by hand from the queue'))
    })

    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([51])
    expect(screen.queryByText('Queued by hand')).toBeNull()
  })

  it('clears the hand-built queue without touching the list being played', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
      usePlayer.getState().addToQueue(song(50, 'Queued by hand'))
    })

    await render(<QueueScreen />, { wrapper })
    await act(async () => {
      fireEvent.press(screen.getByText('Clear'))
    })

    expect(usePlayer.getState().userQueue).toEqual([])
    expect(usePlayer.getState().current?.song.id).toBe(1)
    expect(screen.getByText('Song 2')).toBeTruthy()
  })

  it('toggles shuffle from the queue, keeping the current track', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext(LIBRARY, 1, { kind: 'library' })
    })

    await render(<QueueScreen />, { wrapper })
    await act(async () => {
      fireEvent.press(screen.getByText('Shuffle'))
    })

    expect(usePlayer.getState().shuffle).toBe(true)
    expect(usePlayer.getState().current?.song.id).toBe(2)
  })
})

/**
 * The promise the whole screen is built around (#233, ADR-011).
 *
 * Skipping ahead in the list you are already playing is **not** starting a new
 * list. The obvious implementation — `playFromContext` with the tapped song —
 * would replace the context and strand every hand-queued song behind a pointer
 * that has moved past them, which is precisely the bug ADR-011's two tiers exist
 * to prevent.
 */
describe('skipping to a context track (#233)', () => {
  it('plays it without consuming the user queue', async () => {
    usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
    usePlayer.getState().addToQueue(song(9, 'Hand queued'))
    await render(<QueueScreen />, { wrapper })

    // "Song 3" is the second thing left in the list.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Skip to Song 3'))
    })

    expect(usePlayer.getState().current?.song.id).toBe(3)
    // The whole point: still there, still first when this track ends.
    expect(usePlayer.getState().userQueue.map((s) => s.id)).toEqual([9])
    expect(usePlayer.getState().current?.source).toBe('context')
  })

  it('leaves the rest of the list intact behind it', async () => {
    usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
    await render(<QueueScreen />, { wrapper })

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Skip to Song 2'))
    })

    // The context itself is untouched — only the pointer moved.
    expect(usePlayer.getState().contextQueue).toHaveLength(3)
  })
})

describe('multi-select (#233)', () => {
  const queueThree = () => {
    usePlayer.getState().playFromContext(LIBRARY, 0, { kind: 'library' })
    usePlayer.getState().addToQueue(song(7, 'Queued A'))
    usePlayer.getState().addToQueue(song(8, 'Queued B'))
    usePlayer.getState().addToQueue(song(9, 'Queued C'))
  }

  it('removes several at once', async () => {
    queueThree()
    await render(<QueueScreen />, { wrapper })

    await act(async () => fireEvent.press(screen.getByText('Select')))
    await act(async () => fireEvent.press(screen.getByLabelText('Select Queued A')))
    await act(async () => fireEvent.press(screen.getByLabelText('Select Queued C')))
    await act(async () => fireEvent.press(screen.getByText('Remove')))

    expect(usePlayer.getState().userQueue.map((s) => s.title)).toEqual(['Queued B'])
  })

  it('promotes several to the front, keeping their order', async () => {
    queueThree()
    await render(<QueueScreen />, { wrapper })

    await act(async () => fireEvent.press(screen.getByText('Select')))
    await act(async () => fireEvent.press(screen.getByLabelText('Select Queued B')))
    await act(async () => fireEvent.press(screen.getByLabelText('Select Queued C')))
    await act(async () => fireEvent.press(screen.getByText('Play next')))

    // Promoting two songs must not also shuffle them relative to each other.
    expect(usePlayer.getState().userQueue.map((s) => s.title)).toEqual([
      'Queued B',
      'Queued C',
      'Queued A',
    ])
  })

  it('can be cancelled without changing anything', async () => {
    queueThree()
    await render(<QueueScreen />, { wrapper })

    await act(async () => fireEvent.press(screen.getByText('Select')))
    await act(async () => fireEvent.press(screen.getByLabelText('Select Queued A')))
    await act(async () => fireEvent.press(screen.getByText('Cancel')))

    expect(usePlayer.getState().userQueue).toHaveLength(3)
    // Back to the ordinary view, where dragging is offered again.
    expect(screen.getByText('Select')).toBeTruthy()
  })

  it('offers no destructive action until something is selected', async () => {
    queueThree()
    await render(<QueueScreen />, { wrapper })

    await act(async () => fireEvent.press(screen.getByText('Select')))
    await act(async () => fireEvent.press(screen.getByText('Remove')))

    // Disabled, not hidden: the actions have to be visible for the mode to
    // explain itself, but pressing one with nothing chosen must do nothing.
    expect(usePlayer.getState().userQueue).toHaveLength(3)
  })
})

/**
 * The controls, reachable and usable (#313, #314).
 *
 * Both reported from a device: the chips render *after* the whole queue, so a
 * long queue buries them; and the sleep chip was a `View` that ignored presses.
 */
describe('the queue controls', () => {
  it('puts the controls above the lists, so a long queue does not bury them', async () => {
    const songs = Array.from({ length: 30 }, (_, index) => song(index + 1, `Track ${index + 1}`))
    await act(async () => {
      usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
    })

    await render(<QueueScreen />, { wrapper })

    // Order in the tree is order on the screen: the shuffle chip must come
    // before the first queued row, or you scroll past thirty tracks to reach it.
    const rendered = JSON.stringify(screen.toJSON())
    expect(rendered.indexOf('Shuffle')).toBeLessThan(rendered.indexOf('Track 2'))
  })

  it('opens the sleep options when the chip is pressed', async () => {
    await act(async () => {
      usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })
    })
    await render(<QueueScreen />, { wrapper })

    await act(async () => {
      fireEvent.press(screen.getByText(/Sleep timer/))
    })

    // It was a `View` — I pressed it and nothing happened. One list of
    // options, reachable from both places that show the timer.
    expect(screen.getByText('End of track')).toBeTruthy()
  })

  it('counts down rather than naming a clock time', async () => {
    jest.useFakeTimers()
    try {
      await act(async () => {
        usePlayer.getState().playFromContext([song(1, 'One')], 0, { kind: 'library' })
        usePlayer.getState().setSleepTimer(5)
      })
      await render(<QueueScreen />, { wrapper })

      expect(screen.getByText(/Stopping in 5:00/)).toBeTruthy()

      await act(async () => {
        jest.advanceTimersByTime(61_000)
      })

      // The old label was a pure function of `sleepAt`, so it never moved —
      // and a timer set for under a minute showed the current minute, which
      // reads as "stopping now".
      expect(screen.getByText(/Stopping in 3:59/)).toBeTruthy()
    } finally {
      jest.useRealTimers()
    }
  })
})

/**
 * Dragging what is coming up (#315).
 *
 * The issue warned that a second drag list inside the same `ScrollView` might
 * fight the outer scroll, and said to file it and move on if so. It does not:
 * ADR-018 case 2 — a vertical drag inside a vertical scroll is separated by
 * **time**, not axis, so the scroll view sees a touch that has not moved.
 */
describe('reordering the context queue', () => {
  it('reports a drop into the store', async () => {
    const songs = [song(1, 'One'), song(2, 'Two'), song(3, 'Three'), song(4, 'Four')]
    await act(async () => {
      usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
    })
    await render(<QueueScreen />, { wrapper })

    // Row 0 of what is coming is "Two"; dragged down one row height.
    fireGestureHandler(getByGestureTestId('drag-0'), [
      { state: State.BEGAN, translationY: 0 },
      { state: State.ACTIVE, translationY: 56 },
      { state: State.END, translationY: 56 },
    ])
    await act(async () => {})

    const state = usePlayer.getState()
    expect(
      upNext(state.contextQueue, state.contextOrder, state.contextIndex).map((s) => s.title),
    ).toEqual(['Three', 'Two', 'Four'])
  })

  it('does not move the track that is playing', async () => {
    const songs = [song(1, 'One'), song(2, 'Two'), song(3, 'Three')]
    await act(async () => {
      usePlayer.getState().playFromContext(songs, 0, { kind: 'library' })
    })
    await render(<QueueScreen />, { wrapper })

    fireGestureHandler(getByGestureTestId('drag-0'), [
      { state: State.BEGAN, translationY: 0 },
      { state: State.ACTIVE, translationY: 56 },
      { state: State.END, translationY: 56 },
    ])
    await act(async () => {})

    expect(usePlayer.getState().current?.song.title).toBe('One')
  })
})
