import AsyncStorage from '@react-native-async-storage/async-storage'

import * as client from '../src/api/client'
import { useConnection } from '../src/api/connection'
import { logInfo, useDiagnostics } from '../src/diagnostics/log'
import { isUploadDue, uploadLog, uploadLogIfDue } from '../src/diagnostics/upload'

/**
 * The daily handshake (#322).
 *
 * The rule the whole design rests on: **upload, wait for the acknowledgement,
 * and only then clear.** The phone is the only copy until the server has it, so
 * a device that cleared first would lose a day of diagnostics to one dropped
 * connection — the exact situation the log exists to explain.
 */

const DAY_MS = 24 * 60 * 60 * 1000

let apiFetch: jest.SpyInstance

beforeEach(async () => {
  await AsyncStorage.clear()
  useDiagnostics.setState({ entries: [], lastUploadedAt: null })
  // ⚠️ Since #613 MiO ships pointing at **no** server, and `uploadLog` returns
  // early without one. These tests are about the handshake itself, so they
  // configure one; the no-server case is its own test below.
  useConnection.setState({ serverUrl: 'https://mio.test/api', accessKey: null })
  apiFetch = jest.spyOn(client, 'apiFetch')
})

afterEach(() => {
  apiFetch.mockRestore()
})

describe('uploading', () => {
  it('sends every entry, keyed so the server can dedupe it', async () => {
    apiFetch.mockResolvedValue({ stored: 2, duplicates: 0 })
    logInfo('import.started', 'a')
    logInfo('import.succeeded', 'b')
    const keys = useDiagnostics.getState().entries.map((e) => e.key)

    await uploadLog()

    const [path, init] = apiFetch.mock.calls[0]
    expect(path).toBe('/client-errors/batch')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.items.map((item: { client_key: string }) => item.client_key)).toEqual(keys)
    // The event name is the message, so a row reads as itself in the reader.
    expect(body.items[0].message).toBe('import.started: a')
    expect(body.items[0].level).toBe('info')
  })

  it('marks only after the server has answered', async () => {
    let resolve: (value: unknown) => void = () => {}
    apiFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    logInfo('a')

    const pending = uploadLog()
    // Mid-flight: the phone is still the only copy, so nothing may be claimed.
    expect(useDiagnostics.getState().entries[0].uploadedAt).toBeNull()

    resolve({ stored: 1, duplicates: 0 })
    await pending

    // Marked, and still here (#566). It used to be deleted, which left the
    // diagnostics screen blank for everything older than the daily handshake.
    expect(useDiagnostics.getState().entries).toHaveLength(1)
    expect(useDiagnostics.getState().entries[0].uploadedAt).toEqual(expect.any(Number))
  })

  it('keeps everything when the server cannot be reached', async () => {
    apiFetch.mockRejectedValue(new client.NetworkError('unreachable'))
    logInfo('a')
    logInfo('b')

    const outcome = await uploadLog()

    expect(outcome).toEqual({ ok: false, sent: 0 })
    expect(useDiagnostics.getState().entries).toHaveLength(2)
  })

  it('does not log its own failure, which would fill the log with itself', async () => {
    apiFetch.mockRejectedValue(new client.NetworkError('unreachable'))
    logInfo('a')

    await uploadLog()

    // A server that is down would otherwise generate one failure line per
    // attempt, and the log would fill with its own inability to be sent.
    expect(useDiagnostics.getState().entries.map((e) => e.event)).toEqual(['a'])
  })

  it('marks only what it sent, not what arrived while it was in flight', async () => {
    let resolve: (value: unknown) => void = () => {}
    apiFetch.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    logInfo('sent')

    const pending = uploadLog()
    // The app keeps logging during the request. Marking by time — or marking
    // everything — would claim this as sent having never sent it.
    logInfo('logged during the upload')
    resolve({ stored: 1, duplicates: 0 })
    await pending

    const unsent = useDiagnostics
      .getState()
      .entries.filter((e) => e.uploadedAt == null)
      .map((e) => e.event)
    expect(unsent).toEqual(['logged during the upload'])
  })

  it('does not send an entry twice', async () => {
    /*
     * The consequence of keeping entries, and the thing that would otherwise
     * regress into a daily re-upload of the whole log (#566). The server's
     * key-based dedupe would absorb it, but paying for 300 rows a day to
     * discover they are all duplicates is not a design.
     */
    apiFetch.mockResolvedValue({ stored: 1, duplicates: 0 })
    logInfo('a')
    await uploadLog()

    apiFetch.mockClear()
    logInfo('b')
    await uploadLog()

    const body = JSON.parse((apiFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.items.map((item: { message: string }) => item.message)).toEqual(['b'])
  })

  it('makes no request when everything has already been sent', async () => {
    apiFetch.mockResolvedValue({ stored: 1, duplicates: 0 })
    logInfo('a')
    await uploadLog()

    apiFetch.mockClear()
    const outcome = await uploadLog()

    // A log that is full but fully sent is the same case as an empty one: the
    // day is still done, or the handshake retries on every launch forever.
    expect(apiFetch).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: true, sent: 0 })
  })

  it('counts duplicates as success, because a re-send is the normal case', async () => {
    apiFetch.mockResolvedValue({ stored: 0, duplicates: 3 })
    logInfo('a')

    const outcome = await uploadLog()

    // Everything sent is on the server, whether this request put it there or a
    // previous one whose reply was lost. Marking is correct.
    expect(outcome).toEqual({ ok: true, sent: 3 })
    expect(useDiagnostics.getState().entries[0].uploadedAt).toEqual(expect.any(Number))
  })

  it('makes no request when there is nothing to say, but still marks the day done', async () => {
    const outcome = await uploadLog()

    expect(apiFetch).not.toHaveBeenCalled()
    expect(outcome).toEqual({ ok: true, sent: 0 })
    // Otherwise an empty log means the handshake retries on every launch,
    // forever.
    expect(useDiagnostics.getState().lastUploadedAt).not.toBeNull()
  })
})

describe('when the handshake is due', () => {
  it('is due when it has never run', () => {
    expect(isUploadDue(null)).toBe(true)
  })

  it('is not due again within the day', () => {
    const now = Date.now()
    expect(isUploadDue(now - DAY_MS / 2, now)).toBe(false)
  })

  it('is due once a day has passed', () => {
    const now = Date.now()
    expect(isUploadDue(now - DAY_MS, now)).toBe(true)
  })

  it('is due if the clock has moved backwards', () => {
    // A timezone change or a manual clock set would otherwise park the next
    // upload up to a day in the future.
    const now = Date.now()
    expect(isUploadDue(now + DAY_MS, now)).toBe(true)
  })
})

describe('the launch-time handshake', () => {
  it('uploads when it is due', async () => {
    apiFetch.mockResolvedValue({ stored: 1, duplicates: 0 })
    logInfo('a')

    await uploadLogIfDue()

    expect(apiFetch).toHaveBeenCalled()
  })

  it('does nothing when it already ran today', async () => {
    logInfo('a')
    useDiagnostics.setState({ lastUploadedAt: Date.now() })

    expect(await uploadLogIfDue()).toBeNull()
    expect(apiFetch).not.toHaveBeenCalled()
    // And the log is untouched, so the entries go up with tomorrow's batch.
    expect(useDiagnostics.getState().entries).toHaveLength(1)
  })
})

describe('when there is no server to upload to (#613)', () => {
  it('sends nothing and says why', async () => {
    useConnection.setState({ serverUrl: null })
    logInfo('something', 'worth keeping')

    const outcome = await uploadLog()

    expect(outcome).toMatchObject({ ok: false, sent: 0, reason: 'no-server' })
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('keeps the entries, because the device screen still reads them', async () => {
    // #566: deleting on upload blanked the diagnostics screen for anything
    // older than the last handshake. Having nowhere to send them must not do
    // the same thing by another route.
    useConnection.setState({ serverUrl: null })
    logInfo('something', 'worth keeping')

    await uploadLog()

    expect(useDiagnostics.getState().entries).toHaveLength(1)
  })

  it('does not mark today as done, so a server connected later still gets it', async () => {
    // Stamping `lastUploadedAt` here would silently drop a self-hoster's first
    // day of history the moment they pointed the app at their server.
    useConnection.setState({ serverUrl: null })
    logInfo('something', 'worth keeping')

    await uploadLog()

    expect(useDiagnostics.getState().lastUploadedAt).toBeNull()
  })
})
