import * as SecureStore from 'expo-secure-store'
import { create } from 'zustand'

import { hasSecureRandom as hasSecureRandomSource, randomHex } from '../random'

/**
 * This install's identity (#170).
 *
 * **Owns the library; grants nothing.** The access key decides whether you may
 * search and import; this decides whose songs you see. They were the same field
 * until #170, which meant every keyless user shared one library and adding a key
 * later hid everything imported before it.
 *
 * Minted here rather than issued by the server, so a first launch needs no
 * handshake and no sign-up. It is an *anonymous* identity, not an account:
 * whoever holds the value owns that library.
 *
 * Kept in SecureStore rather than AsyncStorage because losing it loses the
 * library — it is closer to a credential than to configuration. SecureStore
 * survives app updates but **not** an uninstall, which is the honest cost of an
 * anonymous identity and what Phase 6's accounts are for.
 */
// SecureStore keys must be alphanumeric plus ._- (no spaces or slashes).
const INSTALL_ID_KEY = 'mio_install_id'

/** Cached after the first read: `apiFetch` needs this synchronously on every
 *  request, and SecureStore is async. */
let cached: string | null = null

/**
 * Whether the identity is known yet, as something React can wait on (#188).
 *
 * The cache above is a plain variable because `apiFetch` reads it synchronously.
 * That is fine for reading and useless for *waiting*: nothing re-renders when it
 * fills in. So readiness gets its own tiny store, and the root layout holds the
 * app back until it flips.
 *
 * This is the whole bug. `loadInstallId()` was called before any screen mounted
 * and did not **finish** before they did, so the first requests of every cold
 * start went out with no `X-Install-Id`. Writes answered 400 and reads answered
 * `200` with an empty library — the second being far worse, because an empty
 * library looks like lost data rather than a missing header.
 */
export const useInstallReady = create<{ ready: boolean }>(() => ({ ready: false }))

const TOKEN_BYTES = 32

/**
 * 32 bytes of randomness, hex-encoded.
 *
 * The Hermes fallback this depends on lives in `src/random.ts` — shared with
 * the local library's song ids (#246) rather than copied, because that fallback
 * is the part that shipped #188 and is the last thing worth having two of.
 */
function mint(): string {
  return randomHex(TOKEN_BYTES)
}

/** Re-exported so existing callers and tests keep one import site. */
export function hasSecureRandom(): boolean {
  return hasSecureRandomSource()
}

/**
 * Read the stored id, minting one on first launch.
 *
 * Called once from the root layout, before anything can make a request — the
 * same reason the connection store is loaded there.
 */
export async function loadInstallId(): Promise<string> {
  if (cached) {
    useInstallReady.setState({ ready: true })
    return cached
  }

  try {
    const existing = await SecureStore.getItemAsync(INSTALL_ID_KEY)
    if (existing) {
      cached = existing
      return existing
    }

    const minted = mint()
    await SecureStore.setItemAsync(INSTALL_ID_KEY, minted)
    cached = minted
    return minted
  } finally {
    // Ready in `finally`, so a SecureStore failure unblocks the app instead of
    // freezing it on a loading screen forever. The requests that follow will be
    // unidentified and the library will read as empty — bad, but visibly bad,
    // and recoverable by relaunching. A permanent splash screen is neither.
    useInstallReady.setState({ ready: true })
  }
}

/** The id, or empty if it has not been loaded yet. Synchronous, for `apiFetch`. */
export function getInstallId(): string {
  return cached ?? ''
}

/** Test seam only. */
export function __resetInstallId(): void {
  cached = null
  useInstallReady.setState({ ready: false })
}
