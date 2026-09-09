import { logWarn } from '../diagnostics/log'
import { useConnection } from './connection'
import { getInstallId } from './installId'

/**
 * Mirrors the web client's `src/api/client.ts` in shape, with the differences
 * a phone forces:
 *
 * - the base URL is user-supplied at runtime, not a dev-server proxy path;
 * - a request can fail because the phone is on the wrong network, which on the
 *   web basically never happens. That case needs its own error type, because
 *   "can't reach your server" and "your server said no" call for completely
 *   different advice.
 */

export class ApiError extends Error {
  status: number
  /**
   * *Which* failure this is, where the server names one — otherwise null.
   *
   * A status alone is not always enough to decide what to tell the user. The
   * `/google` listing endpoints are the case that forced this (#106): the
   * access-key gate and a dead Google authorization both answer **401**, and
   * they ask for opposite things — add your key, versus reconnect the account.
   * The second happens every 7 days while the consent screen is in Testing, so
   * guessing wrong is not an edge case, it is a weekly one.
   *
   * A string rather than a union: this is whatever the server said, and a
   * client that has not heard of a code treats it as an unnamed failure rather
   * than failing to parse.
   */
  code: string | null

  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** The request never reached the server: wrong address, server down, phone on
 *  mobile data instead of the same Wi-Fi. Carries no status because there was
 *  no response. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NetworkError'
  }
}

/** A stalled connection must fail rather than hang forever behind a spinner. */
const TIMEOUT_MS = 10_000

/**
 * Pull a human-readable message — and a machine-readable code, where there is
 * one — out of FastAPI's error response shapes.
 *
 * Three shapes now, all of them FastAPI's own `detail`:
 *
 * - a **string**, which is every `HTTPException` in this backend bar one;
 * - a **list** of `{loc, msg, type}`, which is a validation error;
 * - an **object** with `message`, which is a failure that needs naming as well
 *   as describing (#106). `message` keeps doing exactly what the string form
 *   did, so nothing that only wants something to show changes.
 */
export async function errorFrom(
  response: Response,
): Promise<{ message: string; code: string | null }> {
  try {
    const body = await response.json()
    const detail = body?.detail
    if (typeof detail === 'string') return { message: detail, code: null }
    // Validation errors come back as a list of {loc, msg, type} objects.
    if (Array.isArray(detail) && detail[0]?.msg) {
      return {
        message: detail.map((d: { msg: string }) => d.msg).join(', '),
        code: null,
      }
    }
    // `!Array.isArray` rather than an order these two branches happen to be
    // written in: `typeof [] === 'object'`, so the named-failure shape has to
    // exclude a validation list *structurally*. Relying on which `if` came
    // first is the kind of guard that survives a reorder and stops working.
    if (
      detail &&
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      typeof detail.message === 'string'
    ) {
      return {
        message: detail.message,
        code: typeof detail.code === 'string' ? detail.code : null,
      }
    }
  } catch {
    // Response wasn't JSON — fall through to the generic message.
  }
  return { message: `Request failed with status ${response.status}`, code: null }
}

/**
 * A request path with everything user-specific taken out, for the log (#354).
 *
 * The query string is the problem: `/search?q=…` **is** what someone typed, and
 * a diagnostic that records it is a diagnostic that records their taste. Numeric
 * ids go too — `/songs/12/audio` says which song.
 *
 * What is left is the route, which is the only part that ever helped: knowing
 * *search* is failing is the diagnosis, knowing what was searched for is not.
 */
export function routeOf(path: string): string {
  return path.split('?')[0].replace(/\/\d+/g, '/:id')
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { serverUrl, accessKey } = useConnection.getState()
  const installId = getInstallId()
  if (!serverUrl) {
    throw new NetworkError('No server configured')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${serverUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        // Permission only: the import endpoints check this (ADR-009). Since #170
        // it no longer decides which library you see.
        ...(accessKey ? { 'X-Unlock-Key': accessKey } : {}),
        // Whose rows this request may see and create (#170). Separate from the
        // key on purpose — one grants permission, the other identifies a library.
        ...(installId ? { 'X-Install-Id': installId } : {}),
        ...init?.headers,
      },
    })
  } catch (cause) {
    // fetch rejects for DNS failures, refused connections and our own abort —
    // all of which mean "never got there", not "got a bad answer".
    const message = cause instanceof Error ? cause.message : 'Request failed'
    // Recorded here because this is the *only* place that knows a request never
    // arrived (#322). Every caller above sees a NetworkError and turns it into
    // its own message, by which point which path failed is lost. The log's
    // repeat guard is what keeps a phone on the wrong network from filling it.
    logWarn('net.unreachable', `${routeOf(path)}: ${message}`)
    throw new NetworkError(message)
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    const { message, code } = await errorFrom(response)
    // A 4xx is usually the user's situation (no key, no install) and a 5xx is
    // always ours; both are worth having, and the status is what tells them
    // apart when read back.
    logWarn('net.rejected', `${routeOf(path)}: ${response.status} ${message}`)
    throw new ApiError(response.status, message, code)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
