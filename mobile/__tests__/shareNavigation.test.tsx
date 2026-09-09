import { renderRouter, screen, act, waitFor } from 'expo-router/testing-library'
import { Text } from 'react-native'

import RootLayout from '../app/_layout'
import TabsLayout from '../app/(tabs)/_layout'
import AddLayout from '../app/(tabs)/add/_layout'
import PlaylistsLayout from '../app/(tabs)/playlists/_layout'
import { resetSharedText, useSharedText } from '../src/library/sharedText'
import '../src/i18n'

/**
 * Where a shared link puts the user (#600).
 *
 * ## Why this needs the real navigator
 *
 * `isOnAddLink` has its own unit tests and they pass against the **broken**
 * app: the bug was never in the predicate, it was that nothing consulted one.
 * The claim here is about the root layout's behaviour *relative to the current
 * route*, which no screen-level test can see — the same reason `shell.test.tsx`
 * mounts the navigator, and the same lesson as #561, where two screens showed
 * their file path as a header while the i18n guard passed because the titles
 * existed and were merely unused.
 *
 * ## The bug it pins
 *
 * A share arriving while Add-link is already open used to `push` a **second**
 * Add-link. `offer()` had already been consumed by the mounted screen, so the
 * new instance came up with an empty box, on top of the filled one. The user
 * saw the link vanish; three shares needed three back-presses to escape.
 *
 * ⚠️ **`renderRouter` works once per file** (see `shell.test.tsx`), so this is
 * one journey rather than several tests.
 */

jest.mock('../src/components/ImportProgressPanel', () => ({
  ImportProgressPanel: () => null,
}))

/**
 * Every `push` the app asks for.
 *
 * ⚠️ **This asserts the call, not the resulting stack, and that is deliberate.**
 * The duplicate screen does not reproduce under `renderRouter`: measured both
 * ways, the router state holds exactly one `link` route whether or not the
 * guard is present, so counting rendered screens or routes cannot fail on the
 * bug — a test written that way passed against it. The device is unambiguous
 * (three shares needed three back-presses), so the environment is what differs.
 * The push is therefore the closest thing to the fault that this suite can
 * actually observe.
 */
const pushes: string[] = []
jest.mock('expo-router', () => {
  const actual = jest.requireActual('expo-router')
  return {
    ...actual,
    useRouter: () => {
      const real = actual.useRouter()
      return {
        ...real,
        push: (href: string) => {
          pushes.push(String(href))
          return real.push(href)
        },
      }
    },
  }
})

jest.mock('../src/player/PlayerHost', () => ({ PlayerHost: () => null }))

/** The listener the root registers, so a share can be fired at will. */
let fireShare: ((text: string) => void) | null = null
jest.mock('../modules/mio-share-intent', () => ({
  // Null: this journey is about the *warm* path. The cold path is covered on
  // the device and by the module's own contract.
  consumePendingShare: () => null,
  onShare: (listener: (text: string) => void) => {
    fireShare = listener
    return () => {
      fireShare = null
    }
  },
}))

function screenStub(label: string) {
  const Stub = () => <Text>{label}</Text>
  Stub.displayName = label
  return Stub
}

function stubs() {
  return {
    _layout: RootLayout,
    setup: screenStub('SETUP SCREEN'),
    queue: screenStub('QUEUE SCREEN'),
    '(tabs)/_layout': TabsLayout,
    '(tabs)/index': screenStub('LIBRARY SCREEN'),
    '(tabs)/playlists/_layout': PlaylistsLayout,
    '(tabs)/playlists/index': screenStub('PLAYLISTS SCREEN'),
    '(tabs)/playlists/[id]': screenStub('PLAYLIST DETAIL SCREEN'),
    '(tabs)/add/_layout': AddLayout,
    '(tabs)/add/index': screenStub('ADD SCREEN'),
    '(tabs)/add/link': screenStub('ADD LINK SCREEN'),
    '(tabs)/add/search': screenStub('SEARCH SCREEN'),
    '(tabs)/add/import/index': screenStub('IMPORT SCREEN'),
    '(tabs)/add/import/[id]': screenStub('IMPORT DETAIL SCREEN'),
    '(tabs)/settings': screenStub('SETTINGS SCREEN'),
  }
}

beforeEach(() => {
  resetSharedText()
  pushes.length = 0
})

it('opens Add-link for a share, and does not stack a second one', async () => {
  renderRouter(stubs(), { initialUrl: '/' })
  await waitFor(() => expect(screen.getByText('LIBRARY SCREEN')).toBeTruthy())
  await waitFor(() => expect(fireShare).not.toBeNull())

  // ---- A share from elsewhere navigates ------------------------------------
  await act(async () => {
    fireShare?.('https://youtu.be/first')
  })
  await waitFor(() => expect(screen.getAllByText('ADD LINK SCREEN').length).toBe(1))
  expect(pushes).toEqual(['/add/link'])
  // Offered for the screen to pick up. The real screen takes it during render;
  // the stub does not, which is what lets the second share below be observed.
  expect(useSharedText.getState().pending).toBe('https://youtu.be/first')

  // ---- A second share, now that Add-link is the current route --------------
  await act(async () => {
    fireShare?.('https://youtu.be/second')
  })

  /*
   * The whole of #600. Before the fix this pushed again, mounting a fresh empty
   * Add-link over the filled one — so the user's link appeared to vanish and a
   * back-press brought it back.
   */
  expect(pushes).toEqual(['/add/link'])

  // And the text still arrives. The fix must not drop the share in order to
  // avoid the duplicate, which would trade a visible bug for a silent one.
  expect(useSharedText.getState().pending).toBe('https://youtu.be/second')
})
