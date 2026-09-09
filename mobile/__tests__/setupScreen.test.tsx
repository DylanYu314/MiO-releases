import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'

import SetupScreen from '../app/setup'
import { useConnection } from '../src/api/connection'
import { checkConnection } from '../src/api/connectionCheck'
import i18n from '../src/i18n'

jest.mock('../src/api/connectionCheck', () => ({
  checkConnection: jest.fn(),
}))

jest.mock('expo-router', () => ({
  usePathname: () => '/setup',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}))

const mockCheck = checkConnection as jest.MockedFunction<typeof checkConnection>

beforeEach(async () => {
  jest.clearAllMocks()
  await i18n.changeLanguage('en')
  mockCheck.mockResolvedValue({ kind: 'ok', locked: false })
  /*
   * ⚠️ A *custom* address, deliberately not the built-in one.
   *
   * `jest.setup.js` mocks `expoConfig.extra.serverUrl` as
   * 'https://mio.test/api', so in tests `DEFAULT_SERVER_URL` is that — while a
   * real build ships `""` (#613). Using the same value here would make
   * `usingDefaultServer` come back true however the save behaved, and the
   * "did not reset the address" assertion below could not fail.
   */
  useConnection.setState({
    serverUrl: 'https://self-hosted.example/api',
    accessKey: null,
    usingDefaultServer: false,
    loaded: true,
  })
})

/*
 * `/setup` had no test of its own until #721, which is why this file exists.
 *
 * It was reachable from two places and was nobody's only route to anything, so
 * the settings tests covered the key. #721 removed the access-key block from
 * Settings — the key gates nothing a normal install can reach — which leaves
 * this screen as the **only** door to a stored key or a custom address.
 *
 * A self-hosting path with no coverage is a path that can be dead without
 * anything saying so (#655's shape), so the two things it must still do are
 * pinned here.
 */
describe('SetupScreen', () => {
  it('stores a key, trimmed', async () => {
    await render(<SetupScreen />)

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Access key'), '  a-real-key  ')
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Connect'))
    })

    // Trimmed: a key pasted from a message often carries whitespace, and an
    // untrimmed one fails authentication for a reason nobody can see.
    await waitFor(() => expect(useConnection.getState().accessKey).toBe('a-real-key'))
    expect(mockCheck).toHaveBeenCalledWith('https://self-hosted.example/api', 'a-real-key')
  })

  it('clears a stored key when the field is emptied', async () => {
    /*
     * ⛔ This is the capability #721 could have deleted silently.
     *
     * Settings had an explicit Clear button; this screen has none. Clearing
     * works because `connect` passes `key.trim() || null`, so an emptied field
     * saves `null` — implicit, and therefore exactly the kind of behaviour that
     * disappears in a refactor with nothing to catch it.
     */
    useConnection.setState({ accessKey: 'existing' })
    await render(<SetupScreen />)

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Access key'), '   ')
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Connect'))
    })

    await waitFor(() => expect(useConnection.getState().accessKey).toBeNull())
    // The address is separate config; clearing a credential must not reset it.
    expect(useConnection.getState().serverUrl).toBe('https://self-hosted.example/api')
    expect(useConnection.getState().usingDefaultServer).toBe(false)
  })
})
