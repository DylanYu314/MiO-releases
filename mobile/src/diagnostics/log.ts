import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

import { randomHex } from '../random'

/**
 * What the app was doing, kept on the device (#322).
 *
 * ## Why
 *
 * *"we encountered many situations where we have a bug, but hard to
 * diagnose the real problem… dont rely on expo metro, its good to have our own
 * logs too."*
 *
 * Metro's console only exists while a laptop is attached and a dev build is
 * running. Almost every bug this iteration fixed was found by *using* the app —
 * away from a terminal, where nothing was recorded at all. This is the record.
 *
 * ## Storage, and why it is not a file
 *
 * The issue said "rolling log file". This is AsyncStorage instead, and the
 * reason is volume: these are events of note — an import that failed, a track
 * that would not play, a request that never came back — a few dozen in a heavy
 * session, not a line per frame. At that rate rewriting a capped array costs
 * nothing, and it buys the same store, serialisation and jest mock every other
 * persisted thing here already uses. A file would win only if the write rate
 * made rewriting expensive, and it does not.
 *
 * The cost is honest: `persist` writes asynchronously, so a hard native crash
 * can lose the last entry or two. The crash path does not depend on this — the
 * `ErrorBoundary` sends its own report immediately — so what is at risk is the
 * breadcrumb *before* a crash, not the crash itself.
 *
 * ## Bounded, always
 *
 * A log with no ceiling on a phone is a bug waiting to happen. Oldest entries
 * are dropped past `MAX_ENTRIES`, which is also the batch cap the server
 * enforces: the device can never build an upload the server would reject.
 */

/** Also the server's per-batch cap, deliberately. A full log is one request. */
export const MAX_ENTRIES = 300

/** How close together two identical entries have to be to count as one. */
export const REPEAT_WINDOW_MS = 60_000

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  /**
   * This entry's name, minted here and sent as the batch's dedupe key.
   *
   * Minted at write time rather than at upload time, which is the whole point:
   * an entry re-sent after a lost acknowledgement carries the *same* key, so the
   * server can recognise it. A key minted per upload would be new every time and
   * dedupe nothing.
   */
  key: string
  level: LogLevel
  /** A short stable name — `import.failed`, `playback.stalled`. Grep-able. */
  event: string
  /** Free text. Whatever the caller knows that the event name does not say. */
  detail: string | null
  at: number
  /**
   * When the server acknowledged this entry, or `null` while it is still ours
   * alone (#566).
   *
   * ## Why this replaced deleting
   *
   * A successful upload used to **remove** the entries it had sent. The log
   * uploads once a day, so the diagnostics screen was blank for everything
   * older than the last handshake — which is exactly the window somebody looks
   * back at when yesterday went wrong. On 2026-08-17 I reported failing
   * imports and *"I don't see any failed error log on the diagnosis"*; the log
   * held one entry, and every line about my failures was on the server and
   * gone from the phone.
   *
   * The device log exists (#322) because *"we encountered many situations where
   * we have a bug, but hard to diagnose the real problem"*, and its whole value
   * is being readable **on the phone**, away from a terminal. Uploading is a
   * second consumer, not the owner, and it was destroying the first one's data.
   *
   * ⚠️ **Not a timestamp anyone should compare across devices.** It is the
   * phone's own clock at the moment the batch returned, kept as a number rather
   * than a boolean only because "when was this sent" is free to store and
   * occasionally the question.
   *
   * Absent on entries persisted before #566; `undefined` reads as unsent, so
   * they go up once more and the server's key-based dedupe absorbs them.
   */
  uploadedAt?: number | null
}

interface DiagnosticsState {
  entries: LogEntry[]
  /** When the daily handshake last succeeded, so it fires once a day. */
  lastUploadedAt: number | null
  append: (level: LogLevel, event: string, detail?: string | null) => void
  /** Mark exactly what the server acknowledged, by key. Drops nothing (#566). */
  markSent: (keys: string[]) => void
  clear: () => void
  markUploaded: (at: number) => void
}

export const useDiagnostics = create<DiagnosticsState>()(
  persist(
    (set) => ({
      entries: [],
      lastUploadedAt: null,

      append: (level, event, detail = null) =>
        set((state) => {
          const previous = state.entries[state.entries.length - 1]
          // A phone on the wrong network fails the same request every few
          // seconds. Left alone that is 300 identical lines and a log that has
          // pushed out everything explaining how it got there — the ceiling
          // protects the *size* and does nothing for the usefulness. Only an
          // immediate repeat is dropped, so an event that recurs either side of
          // something else still shows both times.
          const isImmediateRepeat =
            previous !== undefined &&
            previous.level === level &&
            previous.event === event &&
            previous.detail === (detail ?? null) &&
            Date.now() - previous.at < REPEAT_WINDOW_MS
          if (isImmediateRepeat) return state

          return {
            entries: [
              ...state.entries,
              {
                // 8 bytes of randomness. Not an identity, just a name unique
                // enough that two entries cannot collide — a timestamp would,
                // since a burst of events shares a millisecond routinely.
                key: randomHex(8),
                level,
                event,
                detail: detail ?? null,
                at: Date.now(),
                uploadedAt: null,
              },
            ].slice(-MAX_ENTRIES),
          }
        }),

      /*
       * By key rather than by "everything older than the upload": the app keeps
       * logging *while* an upload is in flight, and marking by time would claim
       * entries that were never sent.
       *
       * Marks rather than deletes (#566). The ceiling is unchanged — a sent
       * entry is dropped by **age** like any other, in `append`'s `slice` — so
       * this does not make the log grow; it only stops the log emptying itself
       * every time it succeeds at its other job.
       */
      markSent: (keys) =>
        set((state) => {
          const sent = new Set(keys)
          const at = Date.now()
          return {
            entries: state.entries.map((entry) =>
              sent.has(entry.key) ? { ...entry, uploadedAt: at } : entry,
            ),
          }
        }),

      clear: () => set({ entries: [] }),

      markUploaded: (at) => set({ lastUploadedAt: at }),
    }),
    {
      name: 'mio-diagnostics',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
)

/**
 * Write a line. The function everything else in the app calls.
 *
 * Deliberately not a hook and deliberately returning nothing: it is called from
 * catch blocks, from player callbacks and from inside async pipelines, none of
 * which are rendering. Logging must never be able to break the thing it is
 * describing, so this swallows its own failures too.
 */
export function logEvent(level: LogLevel, event: string, detail?: string | null): void {
  try {
    useDiagnostics.getState().append(level, event, scrub(detail))
  } catch {
    // A diagnostic that throws is worse than no diagnostic.
  }
}

/**
 * Take anything that identifies a *track* out of a log line (#354).
 *
 * `models.py` and `api/clientErrors.ts` both promise the server holds "no song
 * titles, artists or source URLs". #322 broke that promise: it logged the URL
 * being imported, the title that succeeded, and the title that failed to play —
 * a daily record of what each person listens to, uploaded to a server whose
 * entire justification is that it does **not** hold their library.
 *
 * The call sites were fixed. This exists because fixing call sites is not a
 * guarantee: it is one choke point every line passes through, so the next
 * person to add a diagnostic in a hurry cannot reintroduce the leak. A URL is
 * the one thing here that is *always* wrong to send and is reliably
 * recognisable, which is what makes it worth catching centrally.
 *
 * It is not a substitute for not writing it. A title is indistinguishable from
 * any other text and no filter can catch it — that is why the call sites log
 * the shape of an event rather than its subject.
 */
export function scrub(detail: string | null | undefined): string | null {
  if (detail == null) return null
  return (
    detail
      // Any scheme, because a stream URL from googlevideo identifies the video
      // just as well as a youtube.com watch link does.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
      /*
       * Credentials, by name (#492 slice 3).
       *
       * `SESSDATA` *is* a Bilibili account — no scope, no per-app revocation —
       * and this log is uploaded daily. The rule in `docs/bilibili.md` §6.1 is
       * that it never appears here, and §6.1 also says why this rule is written
       * in code rather than in prose: the same invariant was stated in both
       * `models.py` and `api/clientErrors.ts` and song titles were uploaded for
       * weeks anyway (#354).
       *
       * The URL rule above already hides one inside a link. This catches the
       * shapes that are not links — a `Cookie:` header, a `curl` line pasted
       * into an error, a stringified request object — because "no call site
       * logs it today" is a fact about today.
       */
      .replace(/\b(SESSDATA|bili_jct|refresh_token|access_token)=[^;&\s"']+/gi, '$1=<redacted>')
  )
}

/** Convenience wrappers, so call sites read as what happened. */
export const logInfo = (event: string, detail?: string | null) => logEvent('info', event, detail)
export const logWarn = (event: string, detail?: string | null) => logEvent('warn', event, detail)
export const logError = (event: string, detail?: string | null) => logEvent('error', event, detail)

/**
 * Turn an unknown thrown value into something worth storing.
 *
 * Every catch block in this app catches `unknown`, and `String(error)` on a
 * plain object yields `[object Object]` — a log line that records that
 * something failed and nothing about what.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'unknown error'
  }
}
