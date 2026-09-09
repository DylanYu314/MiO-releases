import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react-native'
import type { ReactElement, ReactNode } from 'react'
import { StyleSheet } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context'

import AddChooser from '../app/(tabs)/add/index'
import PlayingScreen from '../app/playing'
import QueueScreen from '../app/queue'
import { ActionSheet } from '../src/components/ActionSheet'
import { usePlayer } from '../src/player/store'
import type { Song } from '../src/api/types'
import '../src/i18n'

/**
 * Notches, punch-holes and curved edges (#305).
 *
 * `react-native-safe-area-context` was installed and `SafeAreaProvider` was
 * mounted, and that was the whole of it — `useSafeAreaInsets` appeared **nowhere
 * in the app**. Everything that looked right was inherited from React
 * Navigation's chrome, so every screen that hides its chrome was unprotected,
 * and horizontal insets were applied nowhere at all.
 *
 * These assert the padding actually lands, because the failure is invisible on a
 * simulator with no notch — which is exactly why it shipped.
 */

/** A phone with a punch-hole, a gesture bar and curved sides. */
const NOTCHED: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 59, bottom: 34, left: 12, right: 12 },
}

function draw(node: ReactNode): ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return (
    <SafeAreaProvider initialMetrics={NOTCHED}>
      <GestureHandlerRootView>
        <QueryClientProvider client={client}>{node}</QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  )
}

/** The flattened style of a testID'd node, so an assertion reads one number
 *  rather than an array of style objects. */
function styleOf(testID: string): Record<string, number> {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, number>
}

function contentStyleOf(testID: string): Record<string, number> {
  return StyleSheet.flatten(screen.getByTestId(testID).props.contentContainerStyle) as Record<
    string,
    number
  >
}

const SONG: Song = {
  id: 1,
  title: 'Background Test',
  artist: 'The Testers',
  album: null,
  duration: 180,
  source_url: 'https://example.com/1',
  source_platform: 'youtube',
  added_at: '2026-08-01T00:00:00Z',
  loudness_lufs: null,
  peak_dbfs: null,
}

beforeEach(async () => {
  await usePlayer.persist.rehydrate()
  usePlayer.getState().stop()
})

describe('the playing panel, which hides the header entirely', () => {
  beforeEach(async () => {
    await act(async () => {
      usePlayer.getState().playFromContext([SONG], 0, { kind: 'library' })
    })
  })

  it('keeps the close chevron and the 3-dot out of the punch-hole', async () => {
    await render(draw(<PlayingScreen />))

    // 6 points of its own plus the status bar. This is the worst of the four:
    // both controls sat *inside* the notch.
    expect(styleOf('playing-top-bar').paddingTop).toBe(6 + 59)
  })

  it('keeps the bottom of the panel above the gesture bar', async () => {
    await render(draw(<PlayingScreen />))

    expect(contentStyleOf('playing-body').paddingBottom).toBe(32 + 34)
  })

  it('holds the screen off the curved edges', async () => {
    await render(draw(<PlayingScreen />))

    const style = styleOf('playing-screen')
    expect(style.paddingLeft).toBe(12)
    expect(style.paddingRight).toBe(12)
  })
})

describe('the queue, which covers the tab bar', () => {
  it('keeps the last row above the gesture bar', async () => {
    await render(draw(<QueueScreen />))

    // Nothing below it is reserving that space — the tab bar it covers was the
    // only thing that ever did.
    expect(contentStyleOf('queue-scroll').paddingBottom).toBe(40 + 34)
  })
})

describe('the Add tab, which hides the header at both levels', () => {
  it('starts below the status bar rather than under it', async () => {
    await render(draw(<AddChooser />))

    expect(contentStyleOf('add-chooser-scroll').paddingTop).toBe(28 + 59)
  })

  it('adds the curved edges to its own padding rather than replacing it', async () => {
    await render(draw(<AddChooser />))

    const style = contentStyleOf('add-chooser-scroll')
    expect(style.paddingLeft).toBe(20 + 12)
    expect(style.paddingRight).toBe(20 + 12)
  })
})

describe('every bottom sheet in the app', () => {
  it('sits above the gesture bar', async () => {
    // One component backs all of them — the playing options, the speed picker,
    // the sleep timer — so this is fixed once rather than per sheet.
    await render(
      draw(
        <ActionSheet
          visible
          title="Options"
          onClose={() => {}}
          actions={[{ key: 'a', label: 'Do a thing', onPress: () => {} }]}
        />,
      ),
    )

    expect(styleOf('action-sheet').paddingBottom).toBe(24 + 34)
  })
})

describe('a phone with no notch at all', () => {
  it('is left exactly as it was', async () => {
    await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 360, height: 640 },
          insets: { top: 0, bottom: 0, left: 0, right: 0 },
        }}
      >
        <GestureHandlerRootView>
          <ActionSheet
            visible
            title="Options"
            onClose={() => {}}
            actions={[{ key: 'a', label: 'Do a thing', onPress: () => {} }]}
          />
        </GestureHandlerRootView>
      </SafeAreaProvider>,
    )

    // Adding an inset of zero must not change a layout that was already right,
    // or this fix would be a redesign of every screen it touches.
    expect(styleOf('action-sheet').paddingBottom).toBe(24)
    expect(screen.getByText('Do a thing')).toBeTruthy()
  })
})
