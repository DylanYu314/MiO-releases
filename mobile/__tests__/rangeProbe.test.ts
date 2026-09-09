import { describeRangeProbe, probeRangeSupport } from '../src/library/rangeProbe'
import { useDiagnostics } from '../src/diagnostics/log'

/**
 * The probe that decides whether a download can be resumed (#442).
 *
 * #246 established that a **second request on the same URL** is refused, and
 * that is why the downloader makes one bounded call. It says nothing about a
 * **fresh** URL asked for a mid-file range — and pause-and-resume, chunked
 * downloads and the memory ceiling for hour-long tracks all turn on that
 * wider question.
 *
 * What can be tested here is the *instrument*, not the answer: whether it asks
 * both questions, whether it can report either outcome, and whether it can take
 * the screen down. The answer itself only exists on a residential connection
 * (#177), which is why it is a button on a phone.
 */

const mockExtract = jest.fn()
jest.mock('../src/library/extract', () => ({
  extractAudio: (...args: unknown[]) => mockExtract(...args),
}))

function ok(bytes: number, status = 206, contentRange: string | null = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name === 'Content-Range' ? contentRange : null) },
    arrayBuffer: async () => new ArrayBuffer(bytes),
  }
}

beforeEach(() => {
  useDiagnostics.setState({ entries: [] })
  mockExtract.mockReset().mockResolvedValue({
    audio_url: 'https://googlevideo.example/stream',
    http_headers: { 'User-Agent': 'a-client' },
    content_length: 10_000_000,
  })
})

describe('probing whether a fresh URL serves a range', () => {
  it('asks for the second half of the file, with the client headers', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(ok(5_000_000)) as unknown as typeof fetch

    await probeRangeSupport('https://youtu.be/abc')

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    // Mid-file, because "does it serve a range" is the question — asking from
    // byte 0 is answered by any server and would prove nothing.
    //
    // **Bounded**, because the open-ended form downloaded the whole tail to
    // count it: 93 MB and fifty minutes on the 2h54m track I tested (#457).
    // A server that honours a one-megabyte window honours ranges, and
    // `Content-Range` carries the full answer regardless.
    expect(init.headers.Range).toBe('bytes=5000000-6048575')
    // The client's own headers, or googlevideo answers 403 to the download the
    // way it did before #246 sent them.
    expect(init.headers['User-Agent']).toBe('a-client')
  })

  it('asks the same URL a second time, as the control', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(ok(5_000_000)) as unknown as typeof fetch

    await probeRangeSupport('https://youtu.be/abc')

    // Without this a refusal above cannot be told from "this URL was already
    // spent". The control is what makes either answer interpretable.
    expect((globalThis.fetch as jest.Mock).mock.calls).toHaveLength(2)
    expect(mockExtract).toHaveBeenCalledTimes(1)
  })

  it('reports a URL that serves the range as resumable', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(ok(5_000_000, 206, 'bytes 5000000-9999999/10000000'))
      .mockResolvedValueOnce(ok(0, 403)) as unknown as typeof fetch

    const result = await probeRangeSupport('https://youtu.be/abc')

    expect(describeRangeProbe(result)).toContain('resumable=true')
    expect(describeRangeProbe(result)).toContain('second=403')
  })

  it('reports a URL that refuses the range as not resumable', async () => {
    // The instrument has to be able to print both answers, or it has measured
    // nothing — the lesson #371's `running=false` cost this project a day.
    globalThis.fetch = jest.fn().mockResolvedValue(ok(0, 403)) as unknown as typeof fetch

    const result = await probeRangeSupport('https://youtu.be/abc')

    expect(describeRangeProbe(result)).toContain('resumable=false')
    expect(describeRangeProbe(result)).toContain('fresh=403')
  })

  it('never throws, whatever the network does', async () => {
    mockExtract.mockRejectedValue(new Error('no client could provide audio'))

    const result = await probeRangeSupport('https://youtu.be/abc')

    // A diagnostic that can take the screen down with it is worse than none.
    expect(result.error).toContain('no client could provide audio')
    expect(describeRangeProbe(result)).toContain('failed:')
  })

  it('logs the result without the URL in it', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(ok(5_000_000)) as unknown as typeof fetch

    await probeRangeSupport('https://youtu.be/private-taste')

    const entry = useDiagnostics.getState().entries.find((e) => e.event === 'probe.range')
    expect(entry).toBeTruthy()
    // #322 shipped song titles to the server in breach of an invariant stated
    // in two files, and a diagnostic is not a reason to do it again (#354).
    expect(entry?.detail ?? '').not.toContain('private-taste')
  })
})
