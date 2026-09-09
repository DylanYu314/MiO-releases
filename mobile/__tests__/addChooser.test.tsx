import { act, fireEvent, render, screen } from '@testing-library/react-native'

import AddScreen from '../app/(tabs)/add/index'
import { useConnection } from '../src/api/connection'
import '../src/i18n'

/**
 * The head of the Add tab (#226).
 *
 * It carries the guarantee that used to live on the library screen: #199 was
 * "importing a playlist is only reachable from the empty state, so it disappears
 * as soon as you have music". The library's link row is gone now, so this is
 * where that has to be proved — and it is a stronger version of the promise,
 * because this screen is two taps from anywhere rather than one scroll from a
 * particular state.
 */

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: mockPush }),
}))

beforeEach(() => {
  jest.clearAllMocks()
  useConnection.setState({ accessKey: null })
})

describe('the Add chooser', () => {
  it('offers every way in, unconditionally', async () => {
    await render(<AddScreen />)

    expect(screen.getByText('Paste a link')).toBeTruthy()
    expect(screen.getByText('Search')).toBeTruthy()
    expect(screen.getByText('Files on this phone')).toBeTruthy()
    expect(screen.getByText('Import a playlist')).toBeTruthy()
  })

  it('does not describe a server page that no longer exists (#656)', async () => {
    /*
     * #637 deleted the screen and left the sentence introducing it: *"All of
     * them put the music onto this phone, **except the server page** — the
     * server keeps those."* Seen on the device during the 2026-08-20 pass, on
     * the very screen the row had been removed from.
     *
     * The i18n guard could not catch it — the string existed and was used. Only
     * its subject was gone.
     */
    await render(<AddScreen />)

    expect(screen.queryByText(/server page/)).toBeNull()
    expect(
      screen.getByText('Several ways in. All of them put the music onto this phone.'),
    ).toBeTruthy()
  })

  it('no longer offers the server route, which the app has no server for (#637)', async () => {
    /*
     * *"add from other site: if we make the app serverless then remove
     * this feature, just the UI."*
     *
     * `add/bilibili.tsx` handed the link to `POST /jobs`. After #613 the app
     * ships with no server and after #614 that endpoint needs an access key on
     * one the user runs themselves, so for everyone who is not a self-hoster it
     * was a row on this screen that could not work.
     *
     * ⚠️ This row was never in the `it.each` below, which is why nothing on
     * this screen would have noticed either way.
     */
    await render(<AddScreen />)

    expect(screen.queryByText('Other sites')).toBeNull()
    expect(screen.queryByLabelText('Other sites')).toBeNull()
  })

  it.each([
    ['Paste a link', '/add/link'],
    ['Search', '/add/search'],
    ['Files on this phone', '/add/local'],
    ['Import a playlist', '/add/import'],
  ])('sends %s to %s', async (label, href) => {
    await render(<AddScreen />)

    fireEvent.press(screen.getByLabelText(label))

    expect(mockPush).toHaveBeenCalledWith(href)
  })

  /*
   * Both wrapped in `await act`, and that is not decoration.
   *
   * The guard arms a backstop timer on the first press, and an un-awaited press
   * leaves that work straddling the test boundary — which broke the *next two*
   * tests in this file, not this one. It is the same failure recorded elsewhere
   * for a press that mutates a persisted store: the symptom appears in an
   * innocent test.
   */
  it('opens one screen when a destination is tapped twice (#375)', async () => {
    await render(<AddScreen />)

    // My bug 6: two taps in quick succession, two screens, the first
    // immediately covered by the second. `expo-router` queues both pushes and
    // dispatches both — nothing between the press and the navigator dedupes.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Search'))
      fireEvent.press(screen.getByLabelText('Search'))
    })

    expect(mockPush).toHaveBeenCalledTimes(1)
  })

  it('opens one screen when two different destinations are tapped at once', async () => {
    await render(<AddScreen />)

    // The same bug with two fingers, and the one that produces a back stack
    // holding a screen nobody asked for.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Search'))
      fireEvent.press(screen.getByLabelText('Paste a link'))
    })

    expect(mockPush).toHaveBeenCalledTimes(1)
    expect(mockPush).toHaveBeenCalledWith('/add/search')
  })

  /**
   * The reason this screen exists rather than the tab opening onto one of them.
   *
   * A pasted link needs no access key and the other two do (ADR-009). Before
   * #226 you found that out by hitting a lock panel on two screens out of three;
   * saying it up front is the whole value of the extra tap.
   */
  it('says nothing about keys, because no door needs one', async () => {
    await render(<AddScreen />)

    /*
     * This test used to assert three "No key needed" badges and an "Add an
     * access key" button, and it was right when it was written: some doors on
     * this tab were gated by an access key and some were not (ADR-009).
     *
     * None are now — #353 moved search onto the device, #325 made local files
     * reach no server at all, and #611/#612 did the same for every playlist
     * import — so a badge that is true of every row tells a user nothing
     * (#721). The screen is four doors and no caption.
     */
    expect(screen.queryByText('No key needed')).toBeNull()
    expect(screen.queryByText('Add an access key')).toBeNull()

    // The control: the doors are still here. Without it, deleting the whole
    // screen would satisfy both assertions above. ("offers every way in"
    // covers the same ground positively; this is here so *this* test's
    // negatives cannot pass vacuously.)
    expect(screen.getByText('Paste a link')).toBeTruthy()
    expect(screen.getByText('Import a playlist')).toBeTruthy()

    // And with a key stored, which used to be a test of its own. It cannot
    // differ now — the screen no longer reads the connection store at all —
    // and that is the thing worth pinning: no connection state reaches this
    // render, so there is no state in which the key talk comes back.
    await act(async () => {
      useConnection.setState({ accessKey: 'sk-test' })
    })
    expect(screen.queryByText('No key needed')).toBeNull()
    expect(screen.queryByText('Add an access key')).toBeNull()
    expect(screen.getByText('Import a playlist')).toBeTruthy()
  })
})
