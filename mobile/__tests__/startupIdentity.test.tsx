import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, render, screen, waitFor } from '@testing-library/react-native'
import * as SecureStore from 'expo-secure-store'

import RootLayout from '../app/_layout'
import { useConnection } from '../src/api/connection'
import {
  __resetInstallId,
  getInstallId,
  hasSecureRandom,
  loadInstallId,
  useInstallReady,
} from '../src/api/installId'
import '../src/i18n'

/**
 * #188: the first requests of a cold start went out with no `X-Install-Id`.
 *
 * `loadInstallId()` was called before any screen mounted and did not *finish*
 * before they did. The gap between "called" and "completed" is the entire bug,
 * and no existing test could see it because every suite seeds the id
 * synchronously.
 *
 * So these tests make SecureStore slow on purpose. A resolved-immediately mock
 * would pass against the broken code.
 */

// Not under test, and it pulls in the native audio module. What matters here is
// only whether screens mount and start fetching.
jest.mock('../src/player/PlayerHost', () => ({ PlayerHost: () => null }))

/**
 * The library database, which launch now touches (#369's sweep).
 *
 * A healthy device, not an absent one: `openLibraryDb` reaches expo-sqlite's
 * native module, which does not exist under jest, and a sweep that *throws* is
 * a different startup from the one under test — it logs a warning, and a
 * warning is a thing the diagnostics upload sends over the network. This suite
 * asserts that nothing is sent before the install id resolves, so the failure
 * showed up as the bug it was written to catch.
 */
jest.mock('../src/library/db', () => ({
  openLibraryDb: async () => ({
    getAllAsync: async () => [],
    getFirstAsync: async () => null,
    runAsync: async () => {},
  }),
}))

/**
 * Load-bearing, not boilerplate. The real `SafeAreaProvider` renders **nothing**
 * until it has measured insets, which never happens under jest — so without this
 * the tree below it never mounts and "no request was issued" would be true of the
 * broken code too. The mock is what makes this suite capable of failing.
 */
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children?: unknown }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSegments: () => [],
  Stack: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ children }: { children?: unknown }) => require('react').createElement('View', {}, children),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    { Screen: () => require('react').createElement('View') },
  ),
}))

/** Resolves only when the test says so, so "before it finished" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  __resetInstallId()
  jest.clearAllMocks()
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: null,
    usingDefaultServer: true,
    loaded: false,
  })
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ items: [], total: 0, limit: 30, offset: 0 }),
  })) as unknown as typeof fetch
})

describe('startup identity gate (#188)', () => {
  it('issues no request until the install id has resolved', async () => {
    const gate = deferred<string | null>()
    jest.spyOn(SecureStore, 'getItemAsync').mockReturnValue(gate.promise as Promise<string | null>)

    await render(<RootLayout />)

    // The whole point: storage is still in flight, so nothing may have been
    // asked of the server yet. Against the pre-#188 code the library screen has
    // already mounted and fired `GET /songs` by now — unidentified, and answered
    // with an empty library rather than an error.
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(screen.getByTestId('startup-gate')).toBeTruthy()

    await act(async () => {
      gate.resolve('an-existing-install-id')
    })

    await waitFor(() => expect(useInstallReady.getState().ready).toBe(true))
  })

  it('also waits for the stored access key, not just the install id', async () => {
    // #187: "the key isn't saved, I re-enter it every launch." The key is loaded
    // by the same kind of async read, and screens used to render before it
    // arrived — so a stored key read as absent, and requests in that window went
    // out without it. Whether that is the whole of #187 needs a device to say;
    // this pins the half that is provably wrong.
    // The install id resolves at once so it cannot be what holds the gate; the
    // *server address* read is the slow one. Blocking AsyncStorage rather than
    // SecureStore is what isolates the connection half.
    jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue('an-existing-install-id')
    const stored = deferred<string | null>()
    jest.spyOn(AsyncStorage, 'getItem').mockReturnValue(stored.promise as Promise<string | null>)
    useConnection.setState({ loaded: false })

    await render(<RootLayout />)

    await waitFor(() => expect(useInstallReady.getState().ready).toBe(true))
    // Identity is known and the app is *still* held, because the stored key and
    // address have not arrived. Screens must not read "no key" from an
    // unfinished load and must not send a request without it.
    expect(screen.getByTestId('startup-gate')).toBeTruthy()
    expect(globalThis.fetch).not.toHaveBeenCalled()

    await act(async () => {
      stored.resolve(null)
    })

    await waitFor(() => expect(screen.queryByTestId('startup-gate')).toBeNull())
  })

  it('has the id available synchronously by the time the app is let through', async () => {
    jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue('an-existing-install-id')

    await act(async () => {
      await loadInstallId()
    })

    // `apiFetch` reads this synchronously on every request, so "ready" has to
    // mean the cache is populated — not merely that the read has returned.
    expect(useInstallReady.getState().ready).toBe(true)
    expect(getInstallId()).toBe('an-existing-install-id')
  })

  it('mints and stores an id on a first-ever launch', async () => {
    jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(null)
    const write = jest.spyOn(SecureStore, 'setItemAsync')

    const minted = await loadInstallId()

    expect(minted).toHaveLength(64) // 32 random bytes, hex
    expect(write).toHaveBeenCalledWith('mio_install_id', minted)
    expect(useInstallReady.getState().ready).toBe(true)
  })

  it('mints an id on a runtime with no crypto global, as Hermes is', async () => {
    /*
     * The bug this pins shipped, and the reason it shipped is the point:
     * `mint()` called `crypto.getRandomValues`, **jest runs on Node, and Node
     * has `globalThis.crypto`.** The test environment supplied an API the device
     * does not have, so a green suite said nothing at all about Hermes. Every
     * launch needing a new id threw `ReferenceError: Property 'crypto' doesn't
     * exist`, no install id was ever stored, and every write answered 400.
     *
     * So the runtime has to be made to look like the device. Since #195 the
     * fallback is `expo-crypto` rather than `Math.random`, so this also pins
     * that the native path is the one taken when Web Crypto is absent.
     */
    const realCrypto = globalThis.crypto
    // @ts-expect-error — deleting a global is the whole point of this test.
    delete globalThis.crypto
    try {
      // Still secure without Web Crypto — that is what #195 bought. Before it,
      // this was `false` and minting fell back to `Math.random`.
      expect(hasSecureRandom()).toBe(true)
      jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(null)

      const minted = await loadInstallId()

      expect(minted).toHaveLength(64)
      expect(minted).toMatch(/^[0-9a-f]{64}$/)
      expect(getInstallId()).toBe(minted)
    } finally {
      globalThis.crypto = realCrypto
    }
  })

  it('produces different ids on successive mints without crypto', async () => {
    // A fallback that returned a constant would satisfy the test above and hand
    // every install the same library.
    const realCrypto = globalThis.crypto
    // @ts-expect-error — see above.
    delete globalThis.crypto
    try {
      jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(null)

      const first = await loadInstallId()
      __resetInstallId()
      const second = await loadInstallId()

      expect(first).not.toBe(second)
    } finally {
      globalThis.crypto = realCrypto
    }
  })

  it('always has a cryptographic source, on either platform', () => {
    // Web Crypto here (Node), `expo-crypto` on Hermes. If a platform ever turns
    // up with neither, this fails rather than the app silently minting a
    // guessable identity.
    expect(hasSecureRandom()).toBe(true)
  })

  it('lets the app through even if secure storage fails', async () => {
    // A permanent splash screen is a worse failure than an unidentified one: the
    // second is visible and survives a relaunch, the first is indistinguishable
    // from a hung app.
    jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValue(new Error('keystore unavailable'))

    await expect(loadInstallId()).rejects.toThrow('keystore unavailable')
    expect(useInstallReady.getState().ready).toBe(true)
  })
})
