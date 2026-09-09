import { Platform } from 'react-native'
import * as Updates from 'expo-updates'
import Constants from 'expo-constants'

import { MAX_ENTRIES, type LogEntry } from './log'

/**
 * Turn the device's log into something a user can hand over (#664).
 *
 * ## Why this exists
 *
 * 2026-08-20: *"since we removed the server, when bugs happen in the
 * future like today, the app suddenly start rejecting youtube add link, then we
 * need a way to user to report it to us."*
 *
 * Both extraction breakages this week (#534, #651) were found because I hit
 * them himself. A stranger would have had a broken app and no way to say so —
 * and since #613 there is no server to upload to, so `uploadLog()` answers
 * `no-server` for every ordinary user and the "Send now" button it drives can
 * only fail.
 *
 * ⛔ **Nothing leaves the device without a press.** This function only builds a
 * string; the screen puts it on the clipboard or into Android's share sheet, and
 * the user chooses where it goes. the project's ground rules — I operates no service and
 * no personal information enters this repo.
 *
 * ## What goes in, and the one field that is deliberately left out
 *
 * The header carries what made #651 diagnosable: app version, native
 * fingerprint, update id, hardware and Android version.
 *
 * ⚠️ **The device is `Platform.constants.Model`, not `Constants.deviceName`.**
 * They look interchangeable and are not: `deviceName` is the *user-settable*
 * name, which is `RMX3301` on my phone and "<someone>'s Phone" on plenty of
 * others. This report is written to be pasted somewhere public, so a field that
 * is usually a model number and occasionally a person's name is the wrong field.
 * `deviceContext()` still sends `deviceName` to a self-hoster's own server,
 * which is a different audience and stays as it is.
 *
 * The **install id is omitted** for the same reason plus a second one: with no
 * server there is nothing to correlate it against, so it would be an identifier
 * in a public paste that buys nothing.
 *
 * The entries themselves need no filtering here — `scrub()` already replaced
 * every URL and redacted credentials at write time, and #354 stopped song
 * titles reaching the log at all.
 */

/** The build/hardware facts, separated so tests do not need a device. */
export type ReportContext = {
  appVersion: string | null
  runtimeVersion: string | null
  updateId: string
  device: string | null
  os: string | null
  at: number
}

/** How many entries a report carries. */
export const REPORT_ENTRIES = 100

/**
 * ⚠️ Fewer than the log holds (`MAX_ENTRIES` is 300), on purpose.
 *
 * A report is pasted into a form, a message or an issue, and some of those
 * truncate silently. The newest entries are the ones that explain a failure the
 * user just hit, so a cap that keeps them is better than a complete log that
 * gets cut off at an arbitrary point by something downstream.
 */
export function collectContext(): ReportContext {
  return {
    appVersion: Constants.expoConfig?.version ?? null,
    runtimeVersion: Updates.runtimeVersion ?? null,
    updateId: Updates.isEmbeddedLaunch ? 'embedded' : (Updates.updateId ?? '—'),
    device: describeHardware(),
    os: Platform.OS === 'android' ? `Android ${Platform.Version}` : Platform.OS,
    at: Date.now(),
  }
}

function describeHardware(): string | null {
  if (Platform.OS !== 'android') return null
  // Typed loosely because `Platform.constants` differs per platform and this
  // branch has already established which one we are on.
  const c = Platform.constants as unknown as {
    Manufacturer?: string
    Model?: string
  }
  const parts = [c.Manufacturer, c.Model].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  return parts.length > 0 ? parts.join(' ') : null
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** `13:43:07` — the same clock the diagnostics screen shows. */
function clock(at: number): string {
  const d = new Date(at)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/**
 * Build the report. Pure: everything that needs a device is in `context`.
 *
 * `entries` is expected newest-first, as the screen holds them.
 */
export function buildReport(entries: LogEntry[], context: ReportContext): string {
  const shown = entries.slice(0, REPORT_ENTRIES)

  const header = [
    'MiO problem report',
    '',
    `Version   ${context.appVersion ?? '—'}`,
    `Build     ${context.runtimeVersion ?? '—'}`,
    `Update    ${context.updateId}`,
    `Device    ${context.device ?? '—'}${context.os ? ` · ${context.os}` : ''}`,
    `Written   ${new Date(context.at).toISOString()}`,
    '',
  ]

  if (shown.length === 0) {
    // An empty log is a real answer, and one worth saying out loud: on
    // 2026-08-20 an import that logged *nothing* was the whole diagnosis,
    // because every failure line is written by the loop that never ran.
    return [...header, 'Log is empty.'].join('\n')
  }

  const truncated = entries.length > shown.length
  const heading = truncated
    ? `Log — newest first, ${shown.length} of ${entries.length} entries`
    : `Log — newest first, ${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}`

  const lines = shown.map((entry) => {
    const level = entry.level.toUpperCase().padEnd(5)
    const detail = entry.detail ? `  ${entry.detail}` : ''
    return `${clock(entry.at)}  ${level}  ${entry.event}${detail}`
  })

  return [...header, heading, '', ...lines].join('\n')
}

/** Exported so a test can assert the cap is below what the log retains. */
export const LOG_CAPACITY = MAX_ENTRIES

/**
 * Where a user sends the report (#664).
 *
 * A form rather than a `mailto:` or GitHub issues — my call, 2026-08-21.
 * It needs **no account from the user** and **no service from I**: a
 * `mailto:` would publish a personal address and needs a mail client
 * configured, and a GitHub issue needs the reporter to have an account, which
 * is a large ask of someone whose music app has just stopped working.
 *
 * ⚠️ **Empty means the section is not rendered at all**, and that is a
 * deliberate state rather than an oversight. A "report a problem" button that
 * opens nothing is worse than no button — it is the same dead UI this issue
 * exists to remove (`uploadLog()`'s `no-server`, #613). Filling this in is a
 * one-line JavaScript change, so it reaches every install over the air in about
 * a minute without a build.
 *
 * The app does **not** try to prefill the form. Prefilling needs each field's
 * internal id, which differs per provider and breaks silently when the form is
 * edited — so the flow is: copy the report, open the form, paste. That works on
 * every provider and cannot rot.
 */
// Annotated `string` rather than inferred: without it the type is the literal,
// which makes TypeScript treat the render condition as fixed and refuses any
// test that supplies a different URL.
//
// ⚠️ A custom domain on Tally needs their Pro plan, so this is their address
// rather than one of my. Worth noting the cost: if the form ever moves,
// every installed app is pointing here. It is JavaScript, so the fix ships over
// the air in a minute — and the empty-string branch is what makes that
// survivable, since a missing destination degrades to no link rather than to a
// button that opens nothing.
export const REPORT_FORM_URL: string = 'https://tally.so/r/J9EbDd'
