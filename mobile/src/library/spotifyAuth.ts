import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import { create } from 'zustand'

import { describeError, logInfo, logWarn } from '../diagnostics/log'
import { randomHex } from '../random'

/**
 * Signing in to Spotify from the device (#612).
 *
 * The last thing MiO needed a server for. `spotify.py` held the connected
 * account's tokens and the app opened the backend's `/spotify/login`; this
 * moves the whole flow onto the phone, and `serverTracklist.ts` goes with it.
 *
 * ## ⚠️ It needs no native module, and that was worth checking
 *
 * The plan recorded this wave as *"the only one that needs a build"*, on the
 * assumption that `expo-web-browser` was required. It is not:
 *
 * - **The app already receives the OAuth callback as a deep link.** `mio` is
 *   registered in `app.json` and the backend has been redirecting to
 *   `mio://add/import` since Spotify import shipped, which the import screen
 *   already reads with `useLocalSearchParams`. Opening the authorize URL with
 *   React Native's own `Linking` is what the app does *today*, so this is not
 *   even a change in behaviour.
 * - **`expo-crypto` is already installed** and does the SHA-256 the S256
 *   challenge needs.
 *
 * ⚠️ And the obvious place for the client id — `app.json`'s `extra` — **does**
 * move the fingerprint: measured, the `expoConfig` source changes and a build
 * would be forced. It lives in `spotifyConfig.ts` instead, which is ordinary
 * JavaScript and hashes to nothing.
 *
 * So the whole wave ships **over the air**.
 *
 * ## PKCE, with no client secret anywhere
 *
 * This was the finding that made #612 possible at all: `app/spotify.py`'s
 * `exchange_code` takes `client_id`, `code`, `redirect_uri` and `code_verifier`
 * and **no secret**. The flow has been a public-client PKCE flow since it was
 * written, so nothing confidential ever had to live on a server.
 *
 * A client id is public by design — it appears in every authorize URL a user
 * can read — so committing it is correct rather than a leak.
 */

import { SPOTIFY_CLIENT_ID, SPOTIFY_REDIRECT_URI, spotifyConfigured } from './spotifyConfig'

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'

/** The same three the backend asks for, so a user who has already consented
 *  is not asked again for a different set. */
export const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
] as const

// SecureStore keys must be alphanumeric plus `._-`.
const TOKENS_KEY = 'mio_spotify_tokens'
/** The verifier and state, held only between opening the browser and coming
 *  back. Not a credential once the exchange has happened. */
const PENDING_KEY = 'mio_spotify_pending'

/** Refresh this many seconds before expiry, so a request never races it. */
const REFRESH_MARGIN_S = 60

export interface SpotifyTokens {
  accessToken: string
  refreshToken: string | null
  /** Unix seconds. */
  expiresAt: number
  displayName: string | null
  userId: string | null
}

export class SpotifyAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpotifyAuthError'
  }
}

/** Whether an account is connected, for the screens. Mirrors what
 *  `GET /spotify/status` used to answer. */
export const useSpotifyAccount = create<{ connected: boolean; displayName: string | null }>(() => ({
  connected: false,
  displayName: null,
}))

/** base64 → base64url. Spotify rejects `+`, `/` and `=` in a challenge. */
function base64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A verifier and its S256 challenge.
 *
 * The verifier is 64 hex characters — comfortably inside RFC 7636's 43–128 and
 * made only of unreserved characters, so nothing has to be escaped. `randomHex`
 * is the shared minter; ⚠️ **not `crypto`, which Hermes does not have** (#188).
 */
export async function generatePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomHex(32)
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  })
  return { verifier, challenge: base64Url(digest) }
}

/** Where to send the user, having remembered what we will need on the way back. */
export async function beginSignIn(): Promise<string> {
  // Asked, not re-derived: `spotifyConfigured` is the one place that decides
  // whether this build can sign in, and the screens read the same answer.
  if (!spotifyConfigured()) {
    throw new SpotifyAuthError('No Spotify client id is configured in this build')
  }
  const { verifier, challenge } = await generatePkcePair()
  const state = randomHex(16)
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify({ verifier, state }))

  const query = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
    scope: SPOTIFY_SCOPES.join(' '),
    code_challenge_method: 'S256',
    code_challenge: challenge,
  })
  return `${AUTHORIZE_URL}?${query.toString()}`
}

async function postToken(body: Record<string, string>): Promise<SpotifyTokens> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = (payload as { error_description?: string; error?: string } | null) ?? {}
    throw new SpotifyAuthError(
      detail.error_description ??
        detail.error ??
        `Spotify refused the sign-in (${response.status})`,
    )
  }
  const token = payload as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!token?.access_token) throw new SpotifyAuthError('Spotify returned no access token')
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600),
    displayName: null,
    userId: null,
  }
}

/**
 * Finish the sign-in from the deep link Spotify sent us back to.
 *
 * ⚠️ **The state is checked, and a mismatch is refused rather than logged.**
 * It is the only thing standing between this and somebody else's authorization
 * code — the backend checked it too (`state_mismatch`), and dropping the check
 * while moving the flow would be a quiet downgrade.
 */
export async function completeSignIn(params: {
  code?: string
  state?: string
  error?: string
}): Promise<SpotifyTokens> {
  const pendingRaw = await SecureStore.getItemAsync(PENDING_KEY)
  await SecureStore.deleteItemAsync(PENDING_KEY)

  if (params.error) throw new SpotifyAuthError(params.error)
  if (!params.code) throw new SpotifyAuthError('Spotify sent no authorization code')

  const pending = pendingRaw
    ? (JSON.parse(pendingRaw) as { verifier: string; state: string })
    : null
  if (!pending) throw new SpotifyAuthError('This device did not start that sign-in')
  if (!params.state || params.state !== pending.state) {
    throw new SpotifyAuthError('state_mismatch')
  }

  const tokens = await postToken({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: pending.verifier,
  })
  await saveTokens(tokens)
  logInfo('spotify.signedIn', 'tokens stored on device')
  return tokens
}

async function saveTokens(tokens: SpotifyTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens))
  useSpotifyAccount.setState({ connected: true, displayName: tokens.displayName })
}

export async function storedTokens(): Promise<SpotifyTokens | null> {
  const raw = await SecureStore.getItemAsync(TOKENS_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SpotifyTokens
  } catch {
    // Unreadable is the same as absent, and throwing here would make the whole
    // Spotify section unopenable over a corrupt string.
    return null
  }
}

/**
 * A usable access token, refreshing first if it is about to expire.
 *
 * ⚠️ **Spotify may not return a new refresh token**, and the old one stays
 * valid when it does not — so the stored one is kept rather than overwritten
 * with `null`. `_parse_token_response`'s `fallback_refresh_token` did the same
 * job on the server, and losing it silently signs the user out a month later.
 */
export async function accessToken(): Promise<string | null> {
  const tokens = await storedTokens()
  if (!tokens) return null
  if (tokens.expiresAt - REFRESH_MARGIN_S > Math.floor(Date.now() / 1000)) return tokens.accessToken
  if (!tokens.refreshToken) return null

  try {
    const refreshed = await postToken({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: SPOTIFY_CLIENT_ID,
    })
    await saveTokens({
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      displayName: tokens.displayName,
      userId: tokens.userId,
    })
    return refreshed.accessToken
  } catch (error: unknown) {
    logWarn('spotify.refreshFailed', describeError(error))
    return null
  }
}

/** Forget the account. The music it imported is ordinary library rows and stays. */
export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKENS_KEY)
  await SecureStore.deleteItemAsync(PENDING_KEY)
  useSpotifyAccount.setState({ connected: false, displayName: null })
}

/** Read the stored account at launch, so the screen does not flash "sign in". */
export async function loadSpotifyAccount(): Promise<void> {
  const tokens = await storedTokens()
  useSpotifyAccount.setState({
    connected: tokens !== null,
    displayName: tokens?.displayName ?? null,
  })
}

/** Record who signed in, once `/me` has answered. */
export async function rememberProfile(displayName: string | null, userId: string): Promise<void> {
  const tokens = await storedTokens()
  if (!tokens) return
  await saveTokens({ ...tokens, displayName, userId })
}
