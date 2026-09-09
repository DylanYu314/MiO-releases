import { ExtractionFailed, VideoUnavailable } from '../src/library/extract'
import { classifyFailure, isWorthRetrying } from '../src/library/failureKind'

/** What `songs.ts` throws when a download ran out of time with bytes still
 *  arriving. Rebuilt here rather than imported, because `songs.ts` needs
 *  native modules to load — `librarySongs.test.ts` asserts the real one still
 *  carries this name, which is what stops the two drifting apart. */
function downloadWasShort(): Error {
  const error = new Error('Download was short: 10764208 of 14587885 bytes')
  error.name = 'DownloadWasShort'
  return error
}

/**
 * Naming a failure, so the user is told something they can act on (#441).
 *
 * Every download failure has been a string written for whoever is debugging —
 * *"Download refused with status 403 at byte 0"*. That is a good diagnostic and
 * useless to somebody who wants to know whether it is worth trying again.
 *
 * The classification is the part that can be wrong, and a wrong one costs more
 * than none: telling somebody to retry a region-locked video wastes their time
 * on every track it happens to.
 *
 * **The strings are matched against what the throwers actually produce**, and
 * `librarySongs.test.ts` closes that loop by classifying the errors real calls
 * throw. Without that, renaming a message would silently reclassify every
 * failure as `unknown` and nothing would fail.
 */

describe('naming a download failure', () => {
  it('calls a truncated download a timeout, because bytes were still arriving', () => {
    // The #439 case: it was working and ran out of time, which is the one
    // failure where retrying is positively the right move.
    expect(classifyFailure(downloadWasShort())).toBe('timed_out')
  })

  it('calls a dead connection a timeout too', () => {
    expect(classifyFailure(new Error('Download timed out after 300s'))).toBe('timed_out')
  })

  it('separates a refusal from a timeout', () => {
    // Different advice: another client may serve this, but waiting will not.
    // ⚠️ **Not byte 0** — that is its own kind since #639, and this example used
    // to be one, which would make the assertion below vacuous.
    expect(classifyFailure(new Error('Download refused with status 403 at byte 2097152'))).toBe(
      'refused',
    )
  })

  it('separates a refusal at byte 0 from one part-way through (#639)', () => {
    /*
     * Different faults, different advice — and the same sentence until #582 put
     * the offset in it. A refusal after bytes have landed means a spent URL and
     * another client may serve it; a refusal at byte 0 on every client is the
     * signature seen four times, which clears on its own within twenty minutes.
     */
    const atStart = classifyFailure(new Error('Download refused with status 403 at byte 0'))
    expect(atStart).toBe('refused_at_start')
    // Waiting is the observed answer, not a hope.
    expect(isWorthRetrying(atStart)).toBe(true)
  })

  it('does not read a byte offset that merely starts with a zero', () => {
    // The regex is anchored, so `at byte 0` and `at byte 01234` are not the
    // same reading. An unanchored one would file a real mid-file refusal as the
    // transient kind and tell the user to wait for nothing.
    expect(classifyFailure(new Error('Download refused with status 403 at byte 01234'))).toBe(
      'refused',
    )
  })

  it('never calls a region-locked video retryable', () => {
    // `VideoUnavailable` extends `ExtractionFailed`, so a classifier that asked
    // about the parent first would swallow the one case that must not be
    // retried — three seconds of backoff cannot reach a video that is not
    // offered here (#400).
    const kind = classifyFailure(new VideoUnavailable('gone', 'UNPLAYABLE'))
    expect(kind).toBe('unavailable')
    expect(isWorthRetrying(kind)).toBe(false)
  })

  it('calls an exhausted client chain a missing source, not a refusal', () => {
    expect(classifyFailure(new ExtractionFailed('no audio format'))).toBe('no_source')
  })

  it('recognises a request that never reached anybody', () => {
    expect(classifyFailure(new TypeError('Network request failed'))).toBe('offline')
  })

  it('recognises an empty body', () => {
    expect(classifyFailure(new Error('Download returned no bytes'))).toBe('empty')
  })

  it("calls the phone's own failure a device problem, not the track's", () => {
    // #437's collisions arrived exactly like this. Telling somebody to try a
    // different source for a SQLite error would send them hunting a fault that
    // is not in the track.
    const kind = classifyFailure(
      new Error(
        'Call to function "NativeDatabase.execAsync" has been rejected. ' +
          '→ caused by: cannot start a transaction within a transaction',
      ),
    )
    expect(kind).toBe('device')
    expect(isWorthRetrying(kind)).toBe(false)
  })

  it('admits when it does not know', () => {
    // Honest rather than tidy: folding an unrecognised failure into one of the
    // named kinds is how a wrong instruction reaches the user.
    expect(classifyFailure(new Error('something nobody has seen before'))).toBe('unknown')
    expect(classifyFailure('a bare string')).toBe('unknown')
    expect(classifyFailure(null)).toBe('unknown')
  })
})

describe('what the app should offer next', () => {
  it('offers a retry only where trying again could work', () => {
    expect(isWorthRetrying('timed_out')).toBe(true)
    expect(isWorthRetrying('offline')).toBe(true)
    // Another client might serve it, and that is what the chain does.
    expect(isWorthRetrying('refused')).toBe(true)

    // These need a different source or a different phone, not patience.
    expect(isWorthRetrying('unavailable')).toBe(false)
    expect(isWorthRetrying('no_source')).toBe(false)
    expect(isWorthRetrying('device')).toBe(false)
    expect(isWorthRetrying('unknown')).toBe(false)
  })
})

/**
 * The classifier runs inside `catch` blocks, so it must never throw (#441).
 *
 * A classifier that throws while naming a failure turns a handled error into an
 * unhandled one — the same rule #396's probe broke, where an observer could
 * stop the thing it observed.
 *
 * The concrete way it happens is a jest module mock that does not re-export a
 * real error class: `error instanceof undefined` is a `TypeError`, raised from
 * inside the very catch being tested. That has bitten this repo three times
 * (#400, #439, and this change), which is why the guard is in the code rather
 * than in a note asking every future mock to remember.
 */
describe('naming a failure can never itself fail', () => {
  it('survives an error class that a mock replaced with nothing', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/library/extract', () => ({
        // Exactly what a careless mock looks like: the names exist, the classes
        // do not.
        ExtractionFailed: undefined,
        VideoUnavailable: undefined,
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { classifyFailure: classify } = require('../src/library/failureKind')
      expect(() => classify(new Error('Download refused with status 403 at byte 0'))).not.toThrow()
      expect(classify(new Error('Download refused with status 403 at byte 0'))).toBe(
        'refused_at_start',
      )
    })
    jest.dontMock('../src/library/extract')
  })

  it('handles the things that are not errors at all', () => {
    for (const value of [undefined, null, 0, '', {}, [], Symbol('x')]) {
      expect(() => classifyFailure(value)).not.toThrow()
    }
  })
})

/**
 * The phone declining to send a request (#456).
 *
 * Neither a refusal nor a timeout: nobody answered, because nothing was asked.
 * It had been landing in `unknown`, which offers no advice at all.
 */
describe('a cleartext URL Android would not send', () => {
  it('names it rather than calling it unknown', () => {
    const error = new Error(
      'fetch failed: java.net.UnknownServiceException: CLEARTEXT communication to ' +
        'rr1---sn-5hnekn7s.googlevideo.com not permitted by network security policy',
    )
    expect(classifyFailure(error)).toBe('cleartext')
  })

  it('is not mistaken for being offline', () => {
    // React Native's wrapper text can carry both phrases, and "check your
    // network" is the wrong thing to tell someone whose network is fine.
    const error = new Error(
      'Network request failed: java.net.UnknownServiceException: CLEARTEXT ' +
        'communication to googlevideo.com not permitted by network security policy',
    )
    expect(classifyFailure(error)).toBe('cleartext')
  })

  it('leaves an ordinary offline failure alone', () => {
    expect(classifyFailure(new Error('Network request failed'))).toBe('offline')
  })
})
