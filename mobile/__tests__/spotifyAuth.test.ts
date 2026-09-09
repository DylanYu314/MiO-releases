import * as SecureStore from 'expo-secure-store'

import {
  SpotifyAuthError,
  accessToken,
  beginSignIn,
  completeSignIn,
  generatePkcePair,
  signOut,
  storedTokens,
} from '../src/library/spotifyAuth'

/**
 * Signing in to Spotify from the device (#612).
 *
 * The parts that matter here are the ones a server used to be responsible for:
 * that the `state` is actually checked, that a verifier is spent exactly once,
 * and that a refresh does not throw away a refresh token Spotify chose not to
 * resend.
 */

let mockConfigured = true
jest.mock('../src/library/spotifyConfig', () => ({
  SPOTIFY_CLIENT_ID: 'a-client-id',
  SPOTIFY_REDIRECT_URI: 'mio://add/import',
  spotifyConfigured: () => mockConfigured,
}))
jest.mock('../src/diagnostics/log', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
  describeError: (error: Error) => error.message,
}))

/*
 * `expo-crypto` is native, and jest has none of it — but the digest is the
 * whole subject here, so this computes a **real** SHA-256 with Node's crypto
 * rather than returning a canned string. A stub would make
 * "produces a base64url challenge" assert against my own fixture.
 */
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { BASE64: 'base64' },
  digestStringAsync: async (_algorithm: string, data: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('node:crypto') as typeof import('node:crypto'))
      .createHash('sha256')
      .update(data)
      .digest('base64'),
}))

/** SecureStore is native; this is a map with the same three methods. */
const store = new Map<string, string>()
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}))

const nowSeconds = () => Math.floor(Date.now() / 1000)

beforeEach(() => {
  store.clear()
  jest
    .mocked(SecureStore.getItemAsync)
    .mockImplementation(async (key: string) => store.get(key) ?? null)
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key: string, value: string) => {
    store.set(key, value)
  })
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key: string) => {
    store.delete(key)
  })
  globalThis.fetch = jest.fn()
  mockConfigured = true
})

function tokenResponse(body: Record<string, unknown>, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

describe('the PKCE pair', () => {
  it('produces a base64url challenge, with none of the characters Spotify rejects', async () => {
    const { verifier, challenge } = await generatePkcePair()

    // RFC 7636 wants 43–128 unreserved characters; hex is all unreserved.
    expect(verifier).toMatch(/^[0-9a-f]{64}$/)
    expect(challenge).not.toMatch(/[+/=]/)
    expect(challenge.length).toBeGreaterThan(20)
  })

  it('is different every time, or two sign-ins would share a secret', async () => {
    const first = await generatePkcePair()
    const second = await generatePkcePair()

    expect(first.verifier).not.toBe(second.verifier)
    expect(first.challenge).not.toBe(second.challenge)
  })
})

describe('starting a sign-in', () => {
  it('sends Spotify everything the exchange will be checked against', async () => {
    const url = new URL(await beginSignIn())

    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize')
    expect(url.searchParams.get('client_id')).toBe('a-client-id')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('mio://add/import')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    // The same three the backend asked for, so a user who has already consented
    // is not asked again for a different set.
    expect(url.searchParams.get('scope')).toBe(
      'playlist-read-private playlist-read-collaborative user-library-read',
    )
  })

  it('remembers the verifier and state, because the callback proves nothing on its own', async () => {
    const url = new URL(await beginSignIn())

    const pending = JSON.parse(store.get('mio_spotify_pending') as string) as {
      verifier: string
      state: string
    }
    expect(pending.state).toBe(url.searchParams.get('state'))
    expect(pending.verifier).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('finishing a sign-in', () => {
  async function start(): Promise<{ state: string }> {
    const url = new URL(await beginSignIn())
    return { state: url.searchParams.get('state') as string }
  }

  it('exchanges the code and stores the tokens', async () => {
    const { state } = await start()
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValue(
        tokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) as never,
      )

    await completeSignIn({ code: 'the-code', state })

    const tokens = await storedTokens()
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt' })
    const body = String(jest.mocked(globalThis.fetch).mock.calls[0][1]?.body)
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code_verifier=')
    // ⚠️ No client secret, ever. The backend's `exchange_code` takes none
    // either; if one appears here the flow has been turned confidential.
    expect(body).not.toContain('client_secret')
  })

  /**
   * ⚠️ The one check standing between this and somebody else's authorization
   * code. The backend enforced it (`state_mismatch`), and dropping it while
   * moving the flow would be a quiet downgrade.
   */
  it('refuses a state that does not match the one it issued', async () => {
    await start()

    await expect(completeSignIn({ code: 'the-code', state: 'not-the-state' })).rejects.toThrow(
      /state_mismatch/,
    )
    expect(await storedTokens()).toBeNull()
  })

  it('refuses a callback with no state at all', async () => {
    await start()

    await expect(completeSignIn({ code: 'the-code' })).rejects.toThrow(/state_mismatch/)
  })

  /**
   * ⚠️ #538's shape: a confirmed key is spent, and re-polling it reads as
   * expired. The verifier is deleted as it is used, so the *screen* must not
   * exchange twice — and this proves the second attempt genuinely fails rather
   * than silently succeeding against a stale verifier.
   */
  it('spends the verifier, so the same code cannot be exchanged twice', async () => {
    const { state } = await start()
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValue(tokenResponse({ access_token: 'at', expires_in: 3600 }) as never)

    await completeSignIn({ code: 'the-code', state })

    expect(store.has('mio_spotify_pending')).toBe(false)
    await expect(completeSignIn({ code: 'the-code', state })).rejects.toThrow(/did not start/)
  })

  it('reports the error Spotify sent rather than a generic failure', async () => {
    await start()

    await expect(completeSignIn({ error: 'access_denied' })).rejects.toThrow(/access_denied/)
  })

  it('says so when Spotify refuses the exchange', async () => {
    const { state } = await start()
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValue(
        tokenResponse({ error_description: 'Invalid authorization code' }, false, 400) as never,
      )

    await expect(completeSignIn({ code: 'bad', state })).rejects.toThrow(/Invalid authorization/)
  })
})

describe('keeping the token usable', () => {
  async function signedIn(tokens: Record<string, unknown>): Promise<void> {
    store.set(
      'mio_spotify_tokens',
      JSON.stringify({
        accessToken: 'old',
        refreshToken: 'rt',
        displayName: null,
        userId: null,
        ...tokens,
      }),
    )
  }

  it('uses the stored token while it is still good', async () => {
    await signedIn({ expiresAt: nowSeconds() + 600 })

    expect(await accessToken()).toBe('old')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('refreshes one that is about to expire, rather than letting a request fail', async () => {
    // Inside the margin: still valid for a few seconds, which is exactly when a
    // request would race it.
    await signedIn({ expiresAt: nowSeconds() + 5 })
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValue(tokenResponse({ access_token: 'fresh', expires_in: 3600 }) as never)

    expect(await accessToken()).toBe('fresh')
  })

  /**
   * ⚠️ Spotify does not always return a new refresh token, and the old one
   * stays valid when it does not. Overwriting it with `null` signs the user out
   * a month later, for no reason they could connect to anything — which is why
   * the server carried a `fallback_refresh_token` too.
   */
  it('keeps the existing refresh token when the response omits one', async () => {
    await signedIn({ expiresAt: nowSeconds() - 10 })
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValue(tokenResponse({ access_token: 'fresh', expires_in: 3600 }) as never)

    await accessToken()

    expect((await storedTokens())?.refreshToken).toBe('rt')
  })

  it('takes a new refresh token when one is sent', async () => {
    await signedIn({ expiresAt: nowSeconds() - 10 })
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValue(
        tokenResponse({ access_token: 'fresh', refresh_token: 'newer', expires_in: 3600 }) as never,
      )

    await accessToken()

    expect((await storedTokens())?.refreshToken).toBe('newer')
  })

  it('answers null rather than throwing when the refresh is refused', async () => {
    // The caller's job is to say "sign in again"; an exception here would take
    // out whatever screen happened to ask.
    await signedIn({ expiresAt: nowSeconds() - 10 })
    jest
      .mocked(globalThis.fetch)
      .mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, false, 400) as never)

    expect(await accessToken()).toBeNull()
  })

  it('answers null when nobody has signed in', async () => {
    expect(await accessToken()).toBeNull()
  })
})

describe('signing out', () => {
  it('forgets the tokens and anything half-started', async () => {
    await beginSignIn()
    store.set('mio_spotify_tokens', JSON.stringify({ accessToken: 'at' }))

    await signOut()

    expect(await storedTokens()).toBeNull()
    expect(store.has('mio_spotify_pending')).toBe(false)
  })
})

describe('a build with no client id', () => {
  it('refuses to start a sign-in that could only fail at Spotify', async () => {
    // An empty id would send the user to Spotify and bring them back with an
    // opaque `invalid_client`; this names the real problem instead.
    mockConfigured = false

    await expect(beginSignIn()).rejects.toThrow(SpotifyAuthError)
  })
})
