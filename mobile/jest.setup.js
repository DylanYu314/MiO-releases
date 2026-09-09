/**
 * Why `testTimeout` is 20000 in package.json, not jest's default 5000 (#279)
 * -------------------------------------------------------------------------
 *
 * `youtubeImport.test.tsx` blew the 5000 ms cap twice on CI while passing every
 * time locally, on two unrelated commits. Measured rather than guessed:
 *
 *     first  render() in a worker: 624 ms
 *     second render() in a worker:  56 ms
 *
 * An 11x one-time cost — React Native's renderer, the StyleSheet registry and
 * i18n all initialise on the first mount in a worker. Whichever test renders
 * first in its file pays all of it *inside its own timeout*, and CI runs about
 * four to seven times slower than this laptop, which is enough to reach 5 s on
 * its own.
 *
 * So the default was simply mis-set for this project: 5000 ms is chosen for
 * unit tests, and a React Native mount is not one. 20 s is generous enough that
 * only a genuine hang trips it.
 *
 * **This does not hide a suite getting slower** — that was the worry when #279
 * was filed. A timeout is not the instrument for noticing slowness; the CI job's
 * own duration is, and the full run is still ~8 s locally and ~2 min on CI.
 */

/**
 * Native modules have no JavaScript implementation under jest, so they have to
 * be stubbed or every test importing the connection store fails at import time.
 *
 * The stubs are in-memory rather than no-ops so a test can actually assert what
 * was stored — a no-op mock would make "we saved the key" untestable.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
)

jest.mock('expo-secure-store', () => {
  const store = new Map()
  return {
    getItemAsync: jest.fn(async (key) => (store.has(key) ? store.get(key) : null)),
    setItemAsync: jest.fn(async (key, value) => {
      store.set(key, value)
    }),
    deleteItemAsync: jest.fn(async (key) => {
      store.delete(key)
    }),
  }
})

/**
 * `expo-crypto` is a native module, so under jest there is nothing behind it.
 *
 * The mock is *not* how the tests get their randomness — `mint()` prefers Web
 * Crypto, which Node provides, so the real path is exercised. This exists only
 * for the test that deletes `globalThis.crypto` to simulate Hermes, and it
 * returns real random bytes rather than a constant so that test can still assert
 * two mints differ.
 */
jest.mock('expo-crypto', () => ({
  getRandomValues: (array) => {
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256)
    }
    return array
  },
  /*
   * Real digests, not stubs (2026-09-08).
   *
   * Bilibili's WBI signing is `md5(query + mixinKey)`, and a signature that is
   * merely *present* proves nothing — a wrong one is refused with the same 412
   * as not signing at all. Node's own crypto lets a test assert the actual
   * value, so the arithmetic is checked rather than the call.
   */
  CryptoDigestAlgorithm: { MD5: 'MD5', SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' },
  digestStringAsync: async (algorithm, data) =>
    require('node:crypto')
      .createHash(String(algorithm).toLowerCase().replace('-', ''))
      .update(data)
      .digest('hex'),
}))

jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en' }],
}))

/**
 * `Constants.expoConfig` is populated by the native runtime from `app.json`, so
 * under jest it is empty and the baked-in server address (P10d) would read as
 * "" — making every test of default-vs-stored behaviour pass vacuously.
 *
 * A fixed value here rather than the real one from `app.json`: a test that
 * asserts against the production hostname would fail the day the deployment
 * moves, which tells you nothing about the code.
 */
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { serverUrl: 'https://mio.test/api' } } },
}))

/**
 * Safe-area insets, mocked the way the package itself recommends.
 *
 * `useSafeAreaInsets` throws without a provider above it, and #305 put it on
 * every screen that hides its navigation chrome — so without this, every screen
 * test fails on a hook rather than on anything it meant to check.
 *
 * The shipped mock is not a flat zero: it reads `SafeAreaInsetsContext` when
 * one is present and falls back to zeros when it is not. That is exactly what
 * is wanted here — tests that do not care render on a phone with no notch, and
 * a test that *is* about insets wraps itself in a provider and gets real
 * numbers to assert on.
 */
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
)
