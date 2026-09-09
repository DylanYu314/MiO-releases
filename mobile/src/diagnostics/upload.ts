import { apiFetch } from '../api/client'
import { useConnection } from '../api/connection'
import { loadInstallId } from '../api/installId'
import { deviceContext } from '../api/clientErrors'
import { MAX_ENTRIES, useDiagnostics, type LogEntry } from './log'

/**
 * Getting the device's log onto the server (#322).
 *
 * ## The handshake, and why it is in this order
 *
 * Upload → server acknowledges → *then* clear locally. Never the other way
 * round. The phone is the only copy until the server has it, and a device that
 * cleared first would lose a day of diagnostics to one dropped connection —
 * which is the exact situation the log exists to explain.
 *
 * That ordering makes re-sending the normal case rather than an edge case: a
 * reply lost in transit means the same entries go up again tomorrow. Each entry
 * carries the key it was minted with, `POST /client-errors/batch` skips keys it
 * already holds, and the reply counts duplicates as success. Retrying is
 * therefore free, which is what lets the rule be "clear only on acknowledgement"
 * without the log growing forever.
 *
 * ## Why the whole log, not just the errors
 *
 * An error on its own says what broke. What is actually needed is what the app
 * was doing beforehand, which is what the `info` lines are. The server stores a
 * level so the reader can hide them again; throwing them away here would be
 * throwing away the answer.
 */

const DAY_MS = 24 * 60 * 60 * 1000

interface BatchResult {
  stored: number
  duplicates: number
}

/** What the caller needs in order to say something true to the user. */
export interface UploadOutcome {
  ok: boolean
  /** How many entries were dealt with — stored now or already on the server. */
  sent: number
  /** Why nothing was sent, when that is not a failure. `no-server` is the
   *  ordinary case since #613: MiO ships pointing at none. */
  reason?: 'no-server'
}

function toPayload(entry: LogEntry) {
  const context = deviceContext()
  return {
    ...context,
    // The event name is the message, so a row reads as itself in the web
    // reader without the detail having to be opened.
    message: entry.detail ? `${entry.event}: ${entry.detail}` : entry.event,
    // The client's own timestamp is preserved here rather than in a column of
    // its own: `created_at` is when the server received it, which for a daily
    // upload can be most of a day later.
    description: new Date(entry.at).toISOString(),
    level: entry.level,
    client_key: entry.key,
    stack: null,
  }
}

/**
 * Send everything the server has not seen, and mark what it confirms.
 *
 * Returns rather than throws. Every caller is either a background timer or a
 * button, and neither has any use for an exception — the timer would be an
 * unhandled rejection and the button needs to say "that didn't work" either
 * way.
 */
export async function uploadLog(): Promise<UploadOutcome> {
  /*
   * ⚠️ **Nothing to upload to (#613).**
   *
   * MiO ships pointing at no server, so for almost every user this handshake
   * has nowhere to go. Returning early keeps two things true: the log stays
   * whole on the device (#566, where deleting on upload blanked the screen a
   * user actually reads), and `lastUploadedAt` is **not** stamped — so a
   * self-hoster who connects a server later still sends the history rather than
   * finding today already marked done.
   */
  if (!useConnection.getState().serverUrl) return { ok: false, sent: 0, reason: 'no-server' }

  const { entries, markSent, markUploaded } = useDiagnostics.getState()
  /*
   * The unsent ones (#566). The log keeps everything now — deleting on a
   * successful upload left the diagnostics screen blank for anything older than
   * the last daily handshake, which is the window somebody actually looks back
   * at — so "what is there" and "what still needs sending" are two questions.
   *
   * `uploadedAt` is absent on entries written before #566 and `undefined`
   * reads as unsent, so those go up once more. The key-based dedupe on the
   * server is exactly what makes that free.
   */
  const unsent = entries.filter((entry) => entry.uploadedAt == null)
  if (unsent.length === 0) {
    // Nothing to say is still a successful day: mark it, or an empty log means
    // the handshake retries on every launch forever.
    markUploaded(Date.now())
    return { ok: true, sent: 0 }
  }

  // Snapshotted before the request, and this is the point of `markSent(keys)`:
  // the app keeps logging while the upload is in flight, and marking anything
  // other than these exact keys would claim entries never sent.
  const sending = unsent.slice(0, MAX_ENTRIES)

  /*
   * ⚠️ Wait for the install id before posting anything (#188).
   *
   * This runs from the launch effect, and `loadInstallId` reads SecureStore —
   * so without this the handshake races it and can post **unidentified**, which
   * is the exact invariant `startupIdentity.test.tsx` exists to hold. It only
   * bit once there was reliably something to send at launch: before #621 the
   * store was usually empty on the first tick, so the request was skipped and
   * the hole stayed invisible.
   *
   * `loadInstallId` is cached and idempotent, so calling it here costs nothing
   * when the launch effect has already resolved it.
   */
  await loadInstallId()

  try {
    const result = await apiFetch<BatchResult>('/client-errors/batch', {
      method: 'POST',
      body: JSON.stringify({ items: sending.map(toPayload) }),
    })
    markSent(sending.map((entry) => entry.key))
    markUploaded(Date.now())
    return { ok: true, sent: result.stored + result.duplicates }
  } catch {
    // Kept locally, tried again later. The failure is not logged as a new entry
    // on purpose: a server that is down would then generate one failure line
    // per attempt, and the log would fill with its own inability to be sent.
    return { ok: false, sent: 0 }
  }
}

/** Whether the daily handshake is due. Exported so a test can be explicit. */
export function isUploadDue(lastUploadedAt: number | null, now = Date.now()): boolean {
  if (lastUploadedAt === null) return true
  // A clock that has moved backwards — a timezone change, a manual set — would
  // otherwise park the next upload up to a day in the future.
  if (lastUploadedAt > now) return true
  return now - lastUploadedAt >= DAY_MS
}

/**
 * The once-a-day upload, called on launch.
 *
 * On launch rather than on a timer because there is no reliable background
 * execution here: the app is not running most of the day, and a `setInterval`
 * only fires while someone is looking at it. "Once per day, the first time the
 * app is opened that day" is what can actually be delivered, and it is enough —
 * the log is bounded and nothing is lost by arriving late.
 */
export async function uploadLogIfDue(): Promise<UploadOutcome | null> {
  if (!isUploadDue(useDiagnostics.getState().lastUploadedAt)) return null
  return uploadLog()
}
