import {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_REDIRECT_URI,
  spotifyConfigured,
} from '../src/library/spotifyConfig'

/**
 * The two values that must match Spotify's dashboard (#612).
 *
 * ⚠️ **This exists because a *plausible* wrong value is worse than an empty
 * one.** An empty client id makes `beginSignIn` refuse with a message naming
 * the problem; a malformed one sends the user to Spotify and comes back with an
 * opaque `invalid_client` that says nothing about which end is wrong.
 *
 * The first id pasted in was **33 characters** — every one of them valid hex,
 * so nothing but a length check could have noticed.
 */

describe('the Spotify client id', () => {
  it('is either absent or exactly 32 hex characters', () => {
    if (SPOTIFY_CLIENT_ID === '') return
    expect(SPOTIFY_CLIENT_ID).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is never a secret', () => {
    // A client id is public by design — it is in every authorize URL. A client
    // *secret* is the thing that must never reach this file, and PKCE means one
    // is never needed: `app/spotify.py`'s `exchange_code` takes none either.
    const source = jest.requireActual<Record<string, unknown>>('../src/library/spotifyConfig')
    expect(Object.keys(source).join(' ')).not.toMatch(/secret/i)
  })
})

describe('the redirect URI', () => {
  it('is the app scheme, matching what expo-router resolves', () => {
    // `mio` is `app.json`'s scheme and `add/import` is where
    // `app/(tabs)/add/import/index.tsx` lives — route groups are not path
    // segments. Registered in Spotify's dashboard exactly as written.
    expect(SPOTIFY_REDIRECT_URI).toBe('mio://add/import')
  })

  it('is not an https URL, which would be the backend flow again', () => {
    // The old flow redirected to the *server*, which then redirected to the
    // app. Reintroducing an https redirect here would silently put the droplet
    // back in the middle of a sign-in (#608).
    expect(SPOTIFY_REDIRECT_URI.startsWith('http')).toBe(false)
  })
})

describe('spotifyConfigured', () => {
  it('agrees with the id actually present', () => {
    expect(spotifyConfigured()).toBe(SPOTIFY_CLIENT_ID.length > 0)
  })
})
