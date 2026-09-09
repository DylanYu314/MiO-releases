import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { GestureHandlerRootView, State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'

import { SongRow } from '../src/components/SongRow'
import type { PlayableSong } from '../src/api/types'
import '../src/i18n'

/**
 * The track row (#228, #229).
 *
 * The most-repeated element in the app, and — until this file — the only one
 * with no test of its own. Every list renders it, so a mistake here is a mistake
 * everywhere at once.
 *
 * Two changes it exists to hold:
 *
 * - **artwork**, which was impossible before #218 put covers on the device;
 * - **the 3-dot**, which replaces a long press as the way into the options. A
 *   gesture with no affordance is a feature only its author knows about.
 */

function song(overrides: Partial<PlayableSong> = {}): PlayableSong {
  return {
    id: 'local-1',
    title: 'Flower of Japan',
    artist: 'The Testers',
    album: null,
    duration: 200,
    source_url: 'https://youtube.com/watch?v=1',
    source_platform: 'Youtube',
    added_at: '2026-08-01T00:00:00Z',
    loudness_lufs: null,
    peak_dbfs: null,
    file_uri: 'file:///library/local-1.opus',
    cover_uri: 'file:///library/local-1.jpg',
    ...overrides,
  }
}

const noop = () => {}

describe('the artwork', () => {
  it('shows the cover this device holds', async () => {
    await render(<SongRow song={song()} onPress={noop} isCurrent={false} isPlaying={false} />)

    /*
     * `includeHiddenElements` because the artwork is deliberately hidden from
     * screen readers — the title beside it already names the song, so announcing
     * the picture too would make every row read twice. RNTL excludes
     * accessibility-hidden nodes by default, which is the right default and the
     * reason this one query has to opt in.
     */
    const artwork = screen.getByTestId('song-artwork', { includeHiddenElements: true })
    expect(artwork.props.source.uri).toBe('file:///library/local-1.jpg')
    expect(screen.queryByTestId('song-artwork-placeholder')).toBeNull()
  })

  it('falls back to a placeholder rather than a blank square', async () => {
    // No cover is ordinary: plenty of sources have none, and a row imported
    // before #218 has simply not fetched one.
    await render(
      <SongRow
        song={song({ cover_uri: null })}
        onPress={noop}
        isCurrent={false}
        isPlaying={false}
      />,
    )

    expect(screen.queryByTestId('song-artwork', { includeHiddenElements: true })).toBeNull()
    expect(screen.getByTestId('song-artwork-placeholder')).toBeTruthy()
    // The row still renders, which is the point.
    expect(screen.getByText('Flower of Japan')).toBeTruthy()
  })
})

describe('the 3-dot (#229)', () => {
  it('opens the options', async () => {
    const onOptions = jest.fn()
    await render(
      <SongRow
        song={song()}
        onPress={noop}
        onOptions={onOptions}
        isCurrent={false}
        isPlaying={false}
      />,
    )

    fireEvent.press(screen.getByLabelText('More options for Flower of Japan'))

    expect(onOptions).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-1' }))
  })

  it('does not start the song', async () => {
    const onPress = jest.fn()
    const onOptions = jest.fn()
    await render(
      <SongRow
        song={song()}
        onPress={onPress}
        onOptions={onOptions}
        isCurrent={false}
        isPlaying={false}
      />,
    )

    fireEvent.press(screen.getByLabelText('More options for Flower of Japan'))

    // Nested inside the row's own Pressable, so this is the assertion that the
    // inner responder wins. Getting it wrong plays a song every time someone
    // reaches for the menu.
    expect(onPress).not.toHaveBeenCalled()
  })

  it('keeps long-press working as a shortcut', async () => {
    const onOptions = jest.fn()
    await render(
      <SongRow
        song={song()}
        onPress={noop}
        onOptions={onOptions}
        isCurrent={false}
        isPlaying={false}
      />,
    )

    fireEvent(screen.getByLabelText('Play Flower of Japan'), 'longPress')

    // The gesture stops being the *only* way in, not the way in — anyone who
    // already has the habit keeps it.
    expect(onOptions).toHaveBeenCalled()
  })

  it('is absent when a list offers no options', async () => {
    await render(<SongRow song={song()} onPress={noop} isCurrent={false} isPlaying={false} />)

    expect(screen.queryByLabelText('More options for Flower of Japan')).toBeNull()
  })
})

describe('the rest of the row', () => {
  it('plays when tapped', async () => {
    const onPress = jest.fn()
    await render(<SongRow song={song()} onPress={onPress} isCurrent={false} isPlaying={false} />)

    fireEvent.press(screen.getByLabelText('Play Flower of Japan'))

    expect(onPress).toHaveBeenCalled()
  })

  it('offers pausing when it is the track playing', async () => {
    await render(<SongRow song={song()} onPress={noop} isCurrent isPlaying />)

    expect(screen.getByLabelText('Pause Flower of Japan')).toBeTruthy()
  })

  it('hearts without starting the song', async () => {
    const onPress = jest.fn()
    const onToggleFavourite = jest.fn()
    await render(
      <SongRow
        song={song()}
        onPress={onPress}
        isCurrent={false}
        isPlaying={false}
        isFavourite={false}
        onToggleFavourite={onToggleFavourite}
      />,
    )

    fireEvent.press(screen.getByLabelText('Add Flower of Japan to favourites'))

    expect(onToggleFavourite).toHaveBeenCalledWith(expect.objectContaining({ id: 'local-1' }), true)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('hides the heart when a list cannot favourite', async () => {
    await render(<SongRow song={song()} onPress={noop} isCurrent={false} isPlaying={false} />)

    expect(screen.queryByLabelText('Add Flower of Japan to favourites')).toBeNull()
  })

  it('says when a song is known but not downloaded (#268)', async () => {
    // The state a playlist import leaves for a track it could not fetch.
    await render(
      <SongRow
        song={song({ file_uri: null, server_song_id: null })}
        onPress={noop}
        isCurrent={false}
        isPlaying={false}
      />,
    )

    // Silence on tap reads as a broken app; this is what makes it legible.
    // And that it can be *acted on*: tapping the row fetches the audio, which
    // is the only way back for a track an import could not get — and on
    // 2026-08-09 that was found by accident, because the row read as a
    // statement rather than an offer (#377's UI 9).
    expect(screen.getByText(/Not downloaded — tap to get it/)).toBeTruthy()
  })

  it('says when that song is being fetched', async () => {
    await render(
      <SongRow
        song={song({ file_uri: null, server_song_id: null })}
        onPress={noop}
        isCurrent={false}
        isPlaying={false}
        isDownloading
      />,
    )

    expect(screen.getByText(/Downloading/)).toBeTruthy()
  })
})

describe('swiping a row', () => {
  const track = song()

  function renderRow(onSwipeEnqueue?: (song: PlayableSong) => void) {
    return render(
      <GestureHandlerRootView>
        <SongRow
          song={track}
          onPress={jest.fn()}
          isCurrent={false}
          isPlaying={false}
          onSwipeEnqueue={onSwipeEnqueue}
        />
      </GestureHandlerRootView>,
    )
  }

  it('queues the song when the swipe goes far enough', async () => {
    const onSwipeEnqueue = jest.fn()
    await renderRow(onSwipeEnqueue)

    await act(async () => {
      fireGestureHandler(getByGestureTestId(`swipe-${track.id}`), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 120 },
        { state: State.END, translationX: 120 },
      ])
    })

    expect(onSwipeEnqueue).toHaveBeenCalledWith(track)
  })

  it('does nothing when the finger comes back', async () => {
    const onSwipeEnqueue = jest.fn()
    await renderRow(onSwipeEnqueue)

    await act(async () => {
      fireGestureHandler(getByGestureTestId(`swipe-${track.id}`), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 110 },
        // Thought better of it.
        { state: State.END, translationX: 12 },
      ])
    })

    expect(onSwipeEnqueue).not.toHaveBeenCalled()
  })

  it('does nothing when the gesture is cancelled', async () => {
    const onSwipeEnqueue = jest.fn()
    await renderRow(onSwipeEnqueue)

    await act(async () => {
      fireGestureHandler(getByGestureTestId(`swipe-${track.id}`), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 120 },
        { state: State.FAILED, translationX: 120 },
      ])
    })

    // The same rule the scrubber follows: a cancelled gesture is one that lost,
    // and acting on it invents an instruction nobody gave.
    expect(onSwipeEnqueue).not.toHaveBeenCalled()
  })

  it('creates no gesture at all for a list that does not want one', async () => {
    await renderRow(undefined)

    // A row that appears to accept a swipe and then ignores it is worse than a
    // row that does not move, so screens opt in.
    expect(() => getByGestureTestId(`swipe-${track.id}`)).toThrow()
  })
})
