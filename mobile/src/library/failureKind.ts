import { ExtractionFailed, VideoUnavailable } from './extract'

/**
 * What kind of failure this was, as opposed to what it said (#441).
 *
 * ## Why a kind and not a message
 *
 * Every download failure in this app has been a `string` so far, and the strings
 * are written for whoever is debugging: *"Download refused with status 403 at
 * byte 0"*, *"Download was short: 10764208 of 14587885 bytes"*. They are good
 * diagnostics and useless to a user, who wants to know one thing — **is this
 * worth trying again?**
 *
 * The kinds below answer exactly that, and they answer it differently:
 *
 * - `timed_out` — it was working and ran out of time. Retrying is the *right*
 *   move, and since #439 the retry is sized from the rate it measured.
 * - `refused` — a URL that answered 403 **after** bytes had arrived. Retrying
 *   the same client is pointless; another one may work, which is what the
 *   client chain is for.
 * - `refused_at_start` — refused before sending a single byte. Its own kind
 *   because `refused`'s advice — *another source may work* — is wrong here and
 *   was being given four times over: this is the 403-at-byte-0 signature seen
 *   on 2026-08-17, 08-18 and twice on 08-20, where **every** client is refused,
 *   including `ANDROID_VR_DIRECT`, so extraction succeeded and the fetch was
 *   turned away. It clears on its own within about twenty minutes.
 *   ⚠️ **No mechanism is known** and this kind claims none — it names what was
 *   observed (refused before any bytes, transient) and nothing more.
 * - `unavailable` — YouTube will not play this video here at all. Nothing to
 *   retry: the answer will not change (#400). Another *source* might.
 * - `no_source` — every client was asked and none had audio.
 * - `cleartext` — the URL was `http://` and Android refused to send it (#456).
 *   Its own kind because it is neither a refusal nor a timeout: nobody answered,
 *   the phone declined to ask. Retrying another client cannot help — they all
 *   return the same kind of URL — which is exactly what the four attempts on the
 *   2026-08-09 pass demonstrated.
 * - `offline` — the request never reached anybody.
 * - `empty` — a response with no body.
 * - `device` — the phone's own storage or database failed. Not about the track.
 * - `unknown` — kept honest rather than folded into one of the above.
 *
 * ## Why this is a pure function in its own file
 *
 * Because the classification is the part that can be wrong, and a wrong one is
 * worse than none: telling somebody "try again" about a video that is
 * region-locked wastes their time on every track it happens to. Same reasoning
 * as `backgroundStart.ts` and `backgroundedRun.ts` — the judgement lives where
 * a test can hand it every case.
 */
export type FailureKind =
  | 'timed_out'
  | 'refused'
  | 'refused_at_start'
  | 'unavailable'
  | 'no_source'
  | 'cleartext'
  | 'offline'
  | 'empty'
  | 'device'
  | 'unknown'

/** Whether trying the same thing again could plausibly work. Drives whether a
 *  row offers "Retry" or "Change source". */
export function isWorthRetrying(kind: FailureKind): boolean {
  return (
    kind === 'timed_out' ||
    kind === 'offline' ||
    kind === 'refused' ||
    // The one kind where "try again" is not a hope but the observed outcome:
    // it has cleared by itself every time it has been seen (#639).
    kind === 'refused_at_start'
  )
}

/**
 * `instanceof`, but it cannot throw.
 *
 * **This function runs inside `catch` blocks**, and a classifier that throws
 * while naming a failure turns a handled error into an unhandled one — the
 * `observer must not be able to break what it observes` rule, which #396's
 * probe already broke once.
 *
 * The concrete way it happens here is a jest module mock that does not
 * re-export a real error class: `error instanceof undefined` is a `TypeError`,
 * thrown from inside the very catch being tested. That has now bitten this
 * repo three times — #400, #439 and this change — so the guard belongs in the
 * code rather than in a note asking every future mock to remember.
 */
function isInstanceOf(error: unknown, constructor: unknown): boolean {
  return typeof constructor === 'function' && error instanceof constructor
}

/**
 * Name a failure.
 *
 * Ordered most-specific first, and the order matters: `VideoUnavailable`
 * extends `ExtractionFailed`, so asking about the parent first would swallow
 * the one case that must never be retried.
 */
export function classifyFailure(error: unknown): FailureKind {
  /*
   * By `name`, not by `instanceof`, and deliberately.
   *
   * `DownloadWasShort` lives in `songs.ts`, which imports `expo-sqlite` and
   * `expo-file-system` — both native and absent under jest. Importing it here
   * would make the one module whose judgement reaches the user the one module
   * that cannot be tested without a device. `librarySongs.test.ts` asserts the
   * real class still carries this name, so the link cannot rot silently.
   */
  if (error instanceof Error && error.name === 'DownloadWasShort') return 'timed_out'
  /*
   * Bilibili refused the **request**, not the video (#492).
   *
   * `refused` rather than a kind of its own, and that is a judgement about what
   * the user should do: `isWorthRetrying` says yes, and it is right, because
   * every attempt carries a fresh `buvid3` — the cookie whose absence produced
   * the 412 in the first place. Filing it as `rate_limited` (which is how the
   * *server* has classified 412 since #214) would tell someone to wait for
   * something that waiting cannot fix.
   *
   * By `name` for the reason `DownloadWasShort` is: `bilibili.ts` is not
   * importable from here without dragging the extractor in behind it, and
   * `librarySources.test.ts` asserts the real class still carries this name.
   */
  if (error instanceof Error && error.name === 'BilibiliRefused') return 'refused'
  if (isInstanceOf(error, VideoUnavailable)) return 'unavailable'
  if (isInstanceOf(error, ExtractionFailed)) return 'no_source'

  const message = error instanceof Error ? error.message : String(error)

  /*
   * String matching, and it is a liability rather than a design.
   *
   * These messages are thrown as bare `Error`s by `downloadAudioFromUrl`, so
   * there is nothing else to match on. The safeguard is that each phrase is
   * asserted in `failureKind.test.ts` against the *actual* string the thrower
   * produces — so renaming a message breaks a test rather than silently
   * reclassifying every failure as `unknown`.
   */
  if (/^Download timed out after/.test(message)) return 'timed_out'
  if (/^Download was short:/.test(message)) return 'timed_out'
  /*
   * Byte 0 is the whole distinction (#639), and it only exists because #582 put
   * the offset in the message. A refusal at byte 0 and one eight megabytes in
   * are different faults with different answers, and they were the same
   * sentence until then.
   */
  if (/^Download refused with status \d+ at byte 0$/.test(message)) return 'refused_at_start'
  if (/^Download refused with status/.test(message)) return 'refused'
  if (/^Download returned no bytes/.test(message)) return 'empty'

  /*
   * Android refusing to send the request at all (#456).
   *
   * Checked **before** `offline`, and the order is load-bearing: React Native
   * wraps this in `fetch failed`, and a stack that also mentions "Network
   * request failed" would otherwise be filed as "you have no signal" — sending
   * the user to check their connection over a URL scheme.
   */
  if (/CLEARTEXT communication|UnknownServiceException/i.test(message)) return 'cleartext'

  // React Native's fetch says this for a request that never reached anybody —
  // no DNS, no route, aeroplane mode.
  if (/Network request failed/i.test(message)) return 'offline'

  // SQLite and the filesystem. `execAsync` is what #437's collisions surfaced
  // as, and a full disk arrives the same way: it is the phone's problem, not
  // the track's, and telling someone to try a different source would be wrong.
  if (/NativeDatabase|SQLite|transaction|ENOSPC|No space left/i.test(message)) return 'device'

  return 'unknown'
}
