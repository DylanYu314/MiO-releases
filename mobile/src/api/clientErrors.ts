import Constants from 'expo-constants'
import { Platform } from 'react-native'

import { apiFetch } from './client'

/**
 * Telling the server that the app broke (P9, #136).
 *
 * The pilot tester is non-technical and phone-first, so "find the log and email
 * it" is not a plan. The app reports its own failures, and carries the user's
 * description of what they were doing — which is reliably the most useful field
 * in the row, because it is the only one a person wrote.
 *
 * **Reports go to our own server, not a third-party.** Same reasoning as the
 * rest of the project: a crash report is a stack trace from someone's music app,
 * and there is no reason for it to leave the machine that already holds their
 * library.
 *
 * ## What is sent, and what is not
 *
 * Sent: the error message, the stack, the app and OS versions, the device model,
 * and whatever the user typed. **Not sent:** anything about what they were
 * listening to. A stack can still incidentally contain a request path like
 * `/songs/12/audio` — an id, not a title — which is the honest limit of scrubbing
 * a string you did not write.
 *
 * **The rolling log (#322) broke that rule and #354 fixed it.** It sent the URL
 * being imported and the titles that succeeded or failed to play. Enforcement
 * now lives in `diagnostics/log.ts` (`scrub`) and `client.ts` (`routeOf`),
 * because this paragraph existed the whole time and did not stop it.
 */

/** Whatever we can learn about this device without another dependency. */
export function deviceContext(): {
  platform: string
  app_version: string | null
  os_version: string | null
  device: string | null
} {
  return {
    platform: Platform.OS,
    app_version: Constants.expoConfig?.version ?? null,
    // `Platform.Version` is the API level on Android, which is more useful for
    // reproducing than a marketing name.
    os_version: Platform.Version != null ? String(Platform.Version) : null,
    device: Constants.deviceName ?? null,
  }
}

export interface ErrorReport {
  message: string
  stack?: string | null
  /** What the user says they were doing. */
  description?: string | null
}

/**
 * Send a report, and never make a bad situation worse.
 *
 * Reporting a crash must not be able to cause one, so every failure here is
 * swallowed: the server being unreachable is *likely* at exactly the moment
 * something has gone wrong, and an unhandled rejection inside an error handler
 * is how a recoverable screen becomes a dead app.
 *
 * Returns whether it got through, so the UI can say "sent" honestly rather than
 * claiming it.
 */
export async function reportClientError(report: ErrorReport): Promise<boolean> {
  try {
    await apiFetch<unknown>('/client-errors', {
      method: 'POST',
      body: JSON.stringify({
        ...deviceContext(),
        message: report.message.slice(0, 4000),
        stack: report.stack?.slice(0, 20000) ?? null,
        description: report.description?.slice(0, 2000) ?? null,
      }),
    })
    return true
  } catch {
    return false
  }
}
