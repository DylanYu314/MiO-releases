import { ApiError, NetworkError, apiFetch } from './client'
import { normalizeServerUrl, useConnection } from './connection'
import type { AccessStatus } from './types'

/**
 * The result of trying to reach a server, in terms a non-technical user can
 * act on. The pilot tester will hit every one of these, so each has to say what
 * to *do*, not just what went wrong.
 */
export type ConnectionResult =
  | { kind: 'ok'; locked: boolean }
  | { kind: 'unreachable' }
  | { kind: 'keyRejected' }
  | { kind: 'notAServer' }

/**
 * Probe a candidate server *before* saving it.
 *
 * `GET /access/status` is the right probe: it needs no key, exists on every
 * version of the backend, and reports whether the caller's key is accepted —
 * which separates "I can't find your server" from "your server doesn't want
 * this key". Those two need completely different advice.
 */
export async function checkConnection(
  serverUrl: string,
  accessKey: string | null,
): Promise<ConnectionResult> {
  const normalized = normalizeServerUrl(serverUrl)
  if (!normalized) return { kind: 'unreachable' }

  // apiFetch reads the *saved* connection, but this runs before saving — so
  // swap in the candidate values, then put the real ones back.
  const previous = useConnection.getState()
  useConnection.setState({ serverUrl: normalized, accessKey })
  try {
    const status = await apiFetch<AccessStatus>('/access/status')
    if (typeof status?.locked !== 'boolean') return { kind: 'notAServer' }
    // A locked server is not a failed connection. The gate (ADR-009) covers
    // playlist import and search; browsing and playback stay open, so a caller
    // with no key has a perfectly usable app. Only a key that was *offered and
    // refused* is an error worth stopping setup for — otherwise the lock makes
    // the key mandatory, which is precisely what ADR-009 chose not to do.
    if (status.locked && !status.unlocked && accessKey) return { kind: 'keyRejected' }
    return { kind: 'ok', locked: status.locked }
  } catch (error) {
    if (error instanceof NetworkError) return { kind: 'unreachable' }
    // Something answered, but not our API — a router's login page, say.
    if (error instanceof ApiError) return { kind: 'notAServer' }
    return { kind: 'unreachable' }
  } finally {
    useConnection.setState({
      serverUrl: previous.serverUrl,
      accessKey: previous.accessKey,
    })
  }
}
