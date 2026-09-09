import AsyncStorage from '@react-native-async-storage/async-storage'

import { routeOf } from '../src/api/client'
import {
  MAX_ENTRIES,
  REPEAT_WINDOW_MS,
  describeError,
  logError,
  logEvent,
  logInfo,
  scrub,
  useDiagnostics,
} from '../src/diagnostics/log'

/**
 * The on-device log (#322).
 *
 * The behaviour worth pinning is not "it appends" — it is the two things that
 * decide whether the log is still useful an hour into a bad session: the
 * ceiling, and the repeat guard that stops one failing poll from consuming it.
 */

beforeEach(async () => {
  await AsyncStorage.clear()
  useDiagnostics.setState({ entries: [], lastUploadedAt: null })
})

describe('writing a line', () => {
  it('records the level, the event and the detail', () => {
    logInfo('import.started', 'link')

    expect(useDiagnostics.getState().entries).toEqual([
      expect.objectContaining({ level: 'info', event: 'import.started', detail: 'link' }),
    ])
  })

  it('gives every entry its own key, because the key is what dedupes an upload', () => {
    logInfo('a')
    logInfo('b')

    const [first, second] = useDiagnostics.getState().entries
    expect(first.key).not.toBe(second.key)
    expect(first.key).toMatch(/^[0-9a-f]{16}$/)
  })

  it('keeps a missing detail as null rather than undefined, so it survives JSON', () => {
    logInfo('a')

    expect(useDiagnostics.getState().entries[0].detail).toBeNull()
  })

  it('never throws, even if the store is broken underneath it', () => {
    const append = jest.spyOn(useDiagnostics.getState(), 'append').mockImplementation(() => {
      throw new Error('storage is gone')
    })

    // A diagnostic that can break the thing it is describing is worse than no
    // diagnostic — every call site is a catch block or a player callback.
    expect(() => logEvent('error', 'boom')).not.toThrow()

    append.mockRestore()
  })
})

describe('the ceiling', () => {
  it('drops the oldest once the log is full', () => {
    for (let n = 0; n < MAX_ENTRIES + 10; n++) logInfo(`event-${n}`)

    const { entries } = useDiagnostics.getState()
    expect(entries).toHaveLength(MAX_ENTRIES)
    // The oldest ten are gone, and the newest is the last one written.
    expect(entries[0].event).toBe('event-10')
    expect(entries[entries.length - 1].event).toBe(`event-${MAX_ENTRIES + 9}`)
  })
})

describe('the repeat guard', () => {
  it('collapses an immediate identical repeat', () => {
    // A phone on the wrong network fails the same request every few seconds.
    // Unguarded that is 300 identical lines and a log that has pushed out
    // everything explaining how it got there.
    logError('net.unreachable', '/songs: timed out')
    logError('net.unreachable', '/songs: timed out')
    logError('net.unreachable', '/songs: timed out')

    expect(useDiagnostics.getState().entries).toHaveLength(1)
  })

  it('keeps a repeat that is not immediate', () => {
    logError('net.unreachable', '/songs: timed out')
    logInfo('playback.started')
    logError('net.unreachable', '/songs: timed out')

    // Only the *previous* entry is compared, so an event recurring either side
    // of something else still shows both times — which is the shape of a bug
    // that comes and goes.
    expect(useDiagnostics.getState().entries.map((e) => e.event)).toEqual([
      'net.unreachable',
      'playback.started',
      'net.unreachable',
    ])
  })

  it('keeps a repeat once the window has passed', () => {
    logError('net.unreachable', '/songs: timed out')
    // Reaching into the entry rather than faking timers: the guard reads
    // `previous.at`, and moving that back is exactly "this happened a while
    // ago" without making every other await in the file fake.
    const entries = useDiagnostics.getState().entries
    entries[0].at -= REPEAT_WINDOW_MS + 1

    logError('net.unreachable', '/songs: timed out')

    expect(useDiagnostics.getState().entries).toHaveLength(2)
  })

  it('does not collapse two entries that differ only in their detail', () => {
    logError('import.failed', 'first track')
    logError('import.failed', 'second track')

    expect(useDiagnostics.getState().entries).toHaveLength(2)
  })
})

describe('marking what was uploaded (#566)', () => {
  it('marks exactly the keys given and leaves the rest unsent', () => {
    logInfo('a')
    logInfo('b')
    logInfo('c')
    const [first, , third] = useDiagnostics.getState().entries

    useDiagnostics.getState().markSent([first.key, third.key])

    const sent = useDiagnostics.getState().entries.filter((e) => e.uploadedAt != null)
    expect(sent.map((e) => e.event)).toEqual(['a', 'c'])
  })

  it('keeps every entry on the device, which is the whole point', () => {
    /*
     * This used to **delete** what the server acknowledged. The log uploads
     * once a day, so the diagnostics screen went blank for anything older than
     * the last handshake — the exact window somebody looks at when yesterday
     * went wrong. I reported failing imports and "I don't see any failed
     * error log"; the log held one entry and every line about my failures had
     * been uploaded and dropped.
     *
     * Asserted as a **count**, deliberately. An assertion that the marked
     * entries are still present passes against a version that deleted the
     * unmarked ones instead.
     */
    logInfo('a')
    logInfo('b')
    logInfo('c')
    const keys = useDiagnostics.getState().entries.map((e) => e.key)

    useDiagnostics.getState().markSent(keys)

    expect(useDiagnostics.getState().entries).toHaveLength(3)
    expect(useDiagnostics.getState().entries.map((e) => e.event)).toEqual(['a', 'b', 'c'])
  })

  it('still bounds the log, because a sent entry ages out like any other', () => {
    // Marking rather than deleting must not turn the ceiling off: the log lives
    // on a phone and MAX_ENTRIES is also the server's per-batch cap, so the
    // device can never build an upload the server would reject.
    for (let i = 0; i < MAX_ENTRIES + 20; i++) logInfo(`e${i}`)
    useDiagnostics.getState().markSent(useDiagnostics.getState().entries.map((e) => e.key))
    logInfo('one more')

    expect(useDiagnostics.getState().entries).toHaveLength(MAX_ENTRIES)
    expect(useDiagnostics.getState().entries.at(-1)?.event).toBe('one more')
  })
})

describe('describeError', () => {
  it.each([
    [new Error('it broke'), 'it broke'],
    ['a plain string', 'a plain string'],
    [{ status: 403 }, '{"status":403}'],
  ])('turns %p into something worth storing', (input, expected) => {
    expect(describeError(input)).toBe(expected)
  })

  it('does not produce [object Object], which is what String() would', () => {
    // The whole reason this helper exists: a log line recording that something
    // failed and nothing about what.
    expect(describeError({ status: 403 })).not.toBe('[object Object]')
  })

  it('survives a value that cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(describeError(circular)).toBe('unknown error')
  })
})

describe('what a log line is not allowed to carry (#354)', () => {
  /*
   * `models.py` and `api/clientErrors.ts` both promise the server holds "no
   * song titles, artists or source URLs". #322 broke that promise — it logged
   * the URL being imported, the title that succeeded and the title that failed
   * to play, then uploaded the lot daily to a server whose whole justification
   * is that it does not hold anyone's library.
   */

  it.each([
    ['https://www.youtube.com/watch?v=abc123', '<url>'],
    [
      'refused by android: https://rr3---sn-x.googlevideo.com/videoplayback?id=9',
      'refused by android: <url>',
    ],
    ['mio://add/import', '<url>'],
  ])('takes %p out of a line', (input, expected) => {
    expect(scrub(input)).toBe(expected)
  })

  it('leaves a line with nothing identifying in it alone', () => {
    expect(scrub('refused by android, ios')).toBe('refused by android, ios')
  })

  it('scrubs on the way in, not on the way out', () => {
    logError('import.failed', 'gave up on https://youtu.be/xyz')

    // The device's own copy is clean too. Storing it raw and filtering at
    // upload would leave it on disk and one careless read away from leaking.
    expect(useDiagnostics.getState().entries[0].detail).toBe('gave up on <url>')
  })

  it('survives a null detail', () => {
    expect(scrub(null)).toBeNull()
    expect(scrub(undefined)).toBeNull()
  })
})

describe('routeOf — the other half of the same promise (#354)', () => {
  /*
   * `scrub` catches anything with a URL scheme. A request *path* has none, so
   * it slips straight through — and `/search?q=…` is literally what the user
   * typed. This is the guard for that, and it was the one mutation the first
   * pass of these tests did not catch.
   */

  it('drops the query string, which is where a search term lives', () => {
    expect(routeOf('/search?q=daft%20punk&platform=youtube')).toBe('/search')
  })

  it('drops numeric ids, which say which song', () => {
    expect(routeOf('/songs/12/audio')).toBe('/songs/:id/audio')
  })

  it('does both at once', () => {
    expect(routeOf('/playlists/7/items?limit=50')).toBe('/playlists/:id/items')
  })

  it('leaves a plain route alone, because the route is the diagnosis', () => {
    // Knowing *search* is failing is the whole value; knowing what was searched
    // for adds nothing to it.
    expect(routeOf('/client-errors/batch')).toBe('/client-errors/batch')
  })
})
