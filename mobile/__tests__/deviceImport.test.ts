import { useDeviceAdds } from '../src/api/deviceAdds'
import { useDiagnostics } from '../src/diagnostics/log'
import { importToDevice } from '../src/library/deviceImport'
import '../src/i18n'

/**
 * Adding a song with the server nowhere in it (#246).
 *
 * The claim under test is mostly an *absence*: no job, no `X-Install-Id`, no
 * `/songs/{id}/audio`, no `server_song_id`. So these assert what is not there as
 * well as what is — a version that quietly went via the server would otherwise
 * pass everything else.
 */

const mockExtract = jest.fn()
const mockRemoveIfEmpty = jest.fn()
const mockSaveMetadata = jest.fn()
const mockDownload = jest.fn()
const mockSaveCover = jest.fn(async (...args: unknown[]) => null)

jest.mock('../src/library/extract', () => ({
  extractAudio: (...args: unknown[]) => mockExtract(...args),
  CLIENT_CHAIN: ['IOS', 'MWEB', 'TV', 'WEB'],
  // The real class, not a stub: the code under test asks `instanceof`, and a
  // mock that omitted it would make every error look like an ordinary one —
  // silently, since a missing export is `undefined` and `instanceof undefined`
  // throws inside the very catch block being tested (#400).
  VideoUnavailable: jest.requireActual('../src/library/extract').VideoUnavailable,
}))

const mockBilibili = jest.fn()
jest.mock('../src/library/bilibili', () => ({
  extractBilibiliAudio: (...args: unknown[]) => mockBilibili(...args),
  // Pure and cheap, and the thing under test is that the *canonical* URL is
  // what reaches the library — so it is the real one, not a stub that could
  // agree with a wrong caller.
  sourceUrlFor: jest.requireActual('../src/library/bilibili').sourceUrlFor,
  reportRefusal: jest.fn(),
}))

jest.mock('../src/library/songs', () => ({
  // The **real** class: the loop asks `instanceof` to decide whether a client
  // refused us or merely ran out of time, and a stubbed one makes `instanceof`
  // throw inside the very catch being tested — the same trap #400 hit.
  DownloadWasShort: jest.requireActual('../src/library/songs').DownloadWasShort,
  removeSongIfEmpty: (...args: unknown[]) => mockRemoveIfEmpty(...args),
  saveDeviceSongMetadata: (...args: unknown[]) => mockSaveMetadata(...args),
  downloadAudioFromUrl: (...args: unknown[]) => mockDownload(...args),
  saveCover: (...args: unknown[]) => mockSaveCover(...args),
}))

beforeEach(() => {
  mockExtract.mockReset().mockResolvedValue({
    video_id: 'DruvTra8swY',
    title: 'Flower of Japan',
    artist: 'A Channel',
    duration: 214,
    audio_url: 'https://googlevideo.example/audio?expire=1',
    loudness_lufs: -14.3,
    client: 'IOS',
    http_headers: {},
    content_length: 4096,
  })
  mockSaveMetadata.mockReset().mockResolvedValue('local-id-1')
  mockDownload.mockReset().mockResolvedValue({ uri: 'file:///library/local-id-1.opus' })
  mockBilibili.mockReset().mockResolvedValue({
    video_id: 'BV1xx411c7mD',
    title: 'A song',
    artist: 'An Uploader',
    duration: 214,
    audio_url: 'https://upos-sz.bilivideo.com/high.m4s',
    cover_url: 'https://i0.hdslb.com/cover.jpg',
    loudness_lufs: null,
    client: 'bilibili-web',
    http_headers: { Referer: 'https://www.bilibili.com/' },
    content_length: 4096,
  })
})

/**
 * Two sources through one door (#492).
 *
 * The dispatch lives *inside* `importToDevice` rather than at its call sites,
 * and that is the whole design: `useDownloadSong` calls this bare with a stored
 * `source_url`, and so do the playlist imports. Routing here is what gave every
 * one of them Bilibili without changing a line.
 */
describe('choosing an extractor', () => {
  it('sends a Bilibili link to the Bilibili extractor, not YouTube', async () => {
    await importToDevice('https://www.bilibili.com/video/BV1xx411c7mD')

    expect(mockBilibili).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(mockExtract).not.toHaveBeenCalled()
  })

  it('still sends a YouTube link to YouTube', async () => {
    await importToDevice('https://www.youtube.com/watch?v=DruvTra8swY')

    expect(mockExtract).toHaveBeenCalled()
    expect(mockBilibili).not.toHaveBeenCalled()
  })

  it('stores the canonical page and the right platform', async () => {
    await importToDevice('https://www.bilibili.com/video/av170001')

    expect(mockSaveMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        // Not the `av` link that was pasted: `songs.source_url` is UNIQUE since
        // v6, so two spellings of one video must not become two rows.
        source_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
        source_platform: 'Bilibili',
      }),
    )
  })

  it('gives the download the headers the CDN demands', async () => {
    await importToDevice('https://www.bilibili.com/video/BV1xx411c7mD')

    expect(mockDownload).toHaveBeenCalledWith(
      'local-id-1',
      'https://upos-sz.bilivideo.com/high.m4s',
      expect.objectContaining({ Referer: 'https://www.bilibili.com/' }),
      expect.anything(),
    )
  })

  it('gives Bilibili one attempt, because it has one way in', async () => {
    /*
     * YouTube retires a refused client and extracts again as the next one;
     * Bilibili has a single path, so a second pass would be the *same* two API
     * calls asked again, and the outer caller's retry is what buys it time.
     *
     * Provoked with a failing **download**, which is the only thing that
     * reaches the top of the loop a second time — an extraction failure throws
     * out of the first pass whatever the budget is, so asserting on that would
     * have proved nothing. It did: the mutation that raised this budget to four
     * survived until this test was rewritten.
     */
    mockDownload.mockRejectedValue(new Error('403'))

    await expect(importToDevice('https://www.bilibili.com/video/BV1xx411c7mD')).rejects.toThrow()

    expect(mockBilibili).toHaveBeenCalledTimes(1)
  })

  it('tells the record there is one attempt, not four', async () => {
    // What the row says while it works. "Attempt 2 of 4" for a source with one
    // way in is the kind of small lie this iteration keeps removing.
    await importToDevice('https://www.bilibili.com/video/BV1xx411c7mD')

    const record = useDeviceAdds
      .getState()
      .adds.find((add) => add.url === 'https://www.bilibili.com/video/BV1xx411c7mD')
    expect(record?.attempts).toBe(1)
  })

  it('replaces a spent URL through the Bilibili extractor, not the YouTube one', async () => {
    /*
     * #555, the quiet half.
     *
     * The refresh callback (#454) called `extractAudio` directly, so a Bilibili
     * download that stalled mid-file and reached for a fresh URL threw
     * `NotAYouTubeLink` — turning a resumable download into a lost track. It
     * only fires after bytes have already landed, which is why it survived
     * every device pass: the failure needs a stall to appear at all.
     */
    await importToDevice('https://www.bilibili.com/video/BV1xx411c7mD')

    const { refresh } = mockDownload.mock.calls[0][3]
    mockBilibili.mockClear()
    mockExtract.mockClear()

    await expect(refresh()).resolves.toMatchObject({ contentLength: 4096 })
    expect(mockBilibili).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1xx411c7mD')
    expect(mockExtract).not.toHaveBeenCalled()
  })
})

describe('importing straight to the device (#246)', () => {
  it('extracts, records, then downloads — in that order', async () => {
    const result = await importToDevice('https://www.youtube.com/watch?v=DruvTra8swY')

    expect(result).toEqual({
      local_id: 'local-id-1',
      title: 'Flower of Japan',
      artist: 'A Channel',
      client: 'IOS',
    })

    // Metadata before audio, so a failed download leaves a visible, retryable
    // row rather than nothing at all.
    expect(mockSaveMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      mockDownload.mock.invocationCallOrder[0],
    )
  })

  it("passes YouTube's loudness figure through to the row", async () => {
    await importToDevice('DruvTra8swY')

    expect(mockSaveMetadata.mock.calls[0][0].loudness_lufs).toBe(-14.3)
  })

  it('stores the watch URL, not the stream URL', async () => {
    await importToDevice('https://www.youtube.com/watch?v=DruvTra8swY')

    const [song] = mockSaveMetadata.mock.calls[0]
    // Stream URLs expire within hours and are bound to the requesting address,
    // so storing one leaves a row pointing at something that stops existing —
    // and the watch URL is what identifies the same video on a re-import.
    expect(song.source_url).toBe('https://www.youtube.com/watch?v=DruvTra8swY')
    expect(song.source_url).not.toContain('googlevideo')
  })

  it('downloads from the URL YouTube gave, carrying none of *our* identity', async () => {
    await importToDevice('DruvTra8swY')

    const [localId, url, headers] = mockDownload.mock.calls[0]
    expect(localId).toBe('local-id-1')
    expect(url).toBe('https://googlevideo.example/audio?expire=1')
    // This once asserted "no headers at all", which the first real-device run
    // disproved with a 403: googlevideo needs the client's User-Agent back.
    // What must still be absent is anything identifying *us* — the server path
    // needs an install header and this one has no server to talk to.
    expect(headers['X-Install-Id']).toBeUndefined()
    expect(headers['X-Unlock-Key']).toBeUndefined()
  })

  it('does not download when extraction fails', async () => {
    mockExtract.mockRejectedValue(new Error('No client could provide audio'))

    await expect(importToDevice('DruvTra8swY')).rejects.toThrow('No client could provide audio')

    expect(mockSaveMetadata).not.toHaveBeenCalled()
    expect(mockDownload).not.toHaveBeenCalled()
  })

  /**
   * The message for the one failure a user can act on (#400).
   *
   * "No client could provide audio for Kvv5CpePWk0 — ANDROID_VR: no audio
   * format; IOS: no audio format; …" is written for whoever is debugging, and
   * it is what I was shown for a video that is simply not offered in this
   * country (AT, CH, DE only). Nothing in it says "try another source".
   */
  it('says a blocked video is blocked, rather than naming four clients', async () => {
    const { VideoUnavailable } = jest.requireActual('../src/library/extract')
    mockExtract.mockRejectedValue(new VideoUnavailable('Kvv5CpePWk0: nope', 'UNPLAYABLE'))

    await expect(importToDevice('Kvv5CpePWk0')).rejects.toBeTruthy()

    const record = useDeviceAdds.getState().adds[0]
    expect(record.error).toMatch(/blocked in your country/)
    // And not the raw one, which names a video id and no way forward.
    expect(record.error).not.toMatch(/Kvv5CpePWk0/)
  })

  it('says a byte-0 refusal is temporary, rather than naming four clients (#639)', async () => {
    /*
     * The fourth sighting of the same signature, and the first time the user
     * gets a sentence about it. I was shown:
     *
     *   Refused by ANDROID_VR_DIRECT, ANDROID_VR, IOS, TV_SIMPLY. Last download
     *   error: Error: Download refused with status 403 at byte 0
     *
     * Four client names and an HTTP status, and nothing about the one thing
     * that is true of it every time it has been seen: it clears on its own.
     */
    mockDownload.mockRejectedValue(new Error('Download refused with status 403 at byte 0'))

    await expect(importToDevice('DruvTra8swY')).rejects.toBeTruthy()

    const record = useDeviceAdds.getState().adds[0]
    expect(record.error).toMatch(/try again in a few minutes/)
    // The source is named rather than assumed (#565) — a Bilibili refusal must
    // not be reported as YouTube's.
    expect(record.error).toMatch(/^YouTube/)
    // And not the developer's sentence.
    expect(record.error).not.toMatch(/ANDROID_VR|status 403/)
    expect(record.failure).toBe('refused_at_start')
  })

  it('still names the clients for a refusal after bytes arrived (#639)', async () => {
    // The other edge. A URL spent mid-file is not the transient signature, and
    // telling the user to wait for it would be advice about nothing.
    mockDownload.mockRejectedValue(new Error('Download refused with status 403 at byte 2097152'))

    await expect(importToDevice('DruvTra8swY')).rejects.toBeTruthy()

    const record = useDeviceAdds.getState().adds[0]
    expect(record.failure).toBe('refused')
    expect(record.error).not.toMatch(/try again in a few minutes/)
  })

  it('tries the next client when a URL is refused', async () => {
    mockExtract
      .mockResolvedValueOnce({
        video_id: 'x',
        title: 'T',
        artist: 'A',
        duration: 1,
        audio_url: 'https://refused',
        loudness_lufs: null,
        client: 'IOS',
        http_headers: {},
        content_length: null,
      })
      .mockResolvedValueOnce({
        video_id: 'x',
        title: 'T',
        artist: 'A',
        duration: 1,
        audio_url: 'https://works',
        loudness_lufs: null,
        client: 'MWEB',
        http_headers: {},
        content_length: null,
      })
    mockDownload.mockRejectedValueOnce(new Error('status: 403')).mockResolvedValueOnce({})

    const result = await importToDevice('DruvTra8swY')

    // The 403 that broke this on a real phone. A refused URL is as useless as
    // no URL, so the client is retired rather than the import failing.
    expect(result.client).toBe('MWEB')
    expect(mockExtract.mock.calls[1][1]).toEqual({ exclude: ['IOS'] })
  })

  it('gives up naming every client that refused', async () => {
    mockDownload.mockRejectedValue(new Error('status: 403'))

    // "It did not work" with no detail is what made #177 expensive.
    await expect(importToDevice('DruvTra8swY')).rejects.toThrow(/Refused by IOS/)
    expect(mockDownload).toHaveBeenCalledTimes(4)
  })

  it('logs how it was refused, not only by whom (#582)', async () => {
    /*
     * `import.failed` read `refused by ANDROID_VR_DIRECT, ANDROID_VR, IOS,
     * TV_SIMPLY` and nothing else — which is what I quoted on 2026-08-17
     * and all anyone had to work from. It is the same line for a 403 at byte 0,
     * a 403 after the first megabyte and a timeout eight megabytes in.
     *
     * Excluding the **URL** was the decision (#354); excluding the status was a
     * side effect of building the line from `refused` alone. A status and a
     * byte offset identify nothing about the track, and `scrub()` still runs.
     */
    // Module-level and shared with every other test in this file, which is the
    // trap the mobile suite has hit before: without this the assertion below
    // matches an `import.failed` from an earlier case entirely.
    useDiagnostics.getState().clear()
    mockDownload.mockRejectedValue(new Error('Download refused with status 403 at byte 0'))

    await expect(importToDevice('DruvTra8swY')).rejects.toThrow()

    const failed = useDiagnostics.getState().entries.find((e) => e.event === 'import.failed')
    expect(failed?.detail).toMatch(/status 403 at byte 0/)
    // And still names the clients, which is the half that was already right.
    expect(failed?.detail).toMatch(/refused by/)
  })

  it('keeps the URL out of that line, which was never negotiable (#354)', async () => {
    // The reason this line was built from client names in the first place. The
    // log goes to a server that has no business knowing what anyone listens to,
    // and `scrub()` is the enforcement rather than the prose above it.
    useDiagnostics.getState().clear()
    mockDownload.mockRejectedValue(
      new Error('Download refused for https://rr3---sn-x.googlevideo.com/videoplayback?id=9'),
    )

    await expect(importToDevice('DruvTra8swY')).rejects.toThrow()

    const failed = useDiagnostics.getState().entries.find((e) => e.event === 'import.failed')
    expect(failed?.detail).not.toMatch(/googlevideo\.com/)
  })

  it('keeps the download error when extraction then runs out of clients', async () => {
    // The second real-device failure, exactly: a download failed with a status,
    // the next pass found no other usable format, and *that* exception replaced
    // the useful one. The message said "no client could provide audio" while
    // the HTTP status was thrown away.
    mockDownload.mockRejectedValue(new Error('Download refused with status 403 at byte 0'))
    mockExtract
      .mockResolvedValueOnce({
        video_id: 'x',
        title: 'T',
        artist: 'A',
        duration: 1,
        audio_url: 'https://refused',
        loudness_lufs: null,
        client: 'IOS',
        http_headers: {},
        content_length: null,
      })
      .mockRejectedValue(new Error('No client could provide audio'))

    await expect(importToDevice('DruvTra8swY')).rejects.toThrow(/status 403/)
  })

  it('leaves the row behind when a download fails', async () => {
    mockDownload.mockRejectedValue(new Error('offline'))

    await expect(importToDevice('DruvTra8swY')).rejects.toThrow()

    // The row was written first and stays: the song shows as known but not
    // downloaded, which the user can act on.
    expect(mockSaveMetadata).toHaveBeenCalled()
  })

  it('passes the stated length to the download', async () => {
    await importToDevice('DruvTra8swY')

    // What the chunked download counts towards, and what it checks a refreshed
    // URL against before resuming onto it (#454).
    expect(mockDownload.mock.calls[0][3]).toMatchObject({ contentLength: 4096 })
  })

  it('gives the download a way to replace a URL that stops serving', async () => {
    await importToDevice('DruvTra8swY')

    // #454: a refusal after bytes have landed means the URL is spent, not the
    // video refused. Without this the download would throw away what it had.
    const { refresh } = mockDownload.mock.calls[0][3]
    mockExtract.mockClear()
    await expect(refresh()).resolves.toMatchObject({ contentLength: 4096 })
    expect(mockExtract).toHaveBeenCalled()
  })
})

/**
 * A track whose audio never arrives leaves nothing behind (#309).
 *
 * "one song that displays as not downloaded yet is also being added in
 * the library, it shouldn't happen if it's not downloaded." The library means
 * *music I have*; a row with no file is a promise it cannot keep. Where the
 * failure is still visible is the record on the page it was added from (#318).
 */
describe('when the audio never arrives (#309)', () => {
  it('removes the row it created', async () => {
    mockDownload.mockRejectedValue(new Error('403'))

    await expect(importToDevice('https://www.youtube.com/watch?v=DruvTra8swY')).rejects.toThrow()

    // Once per client that was tried and failed — the row is recreated by the
    // next attempt, so each one cleans up after itself.
    expect(mockRemoveIfEmpty).toHaveBeenCalledWith('local-id-1')
  })

  it('delegates the decision rather than deleting outright', async () => {
    mockDownload.mockRejectedValue(new Error('403'))

    await expect(importToDevice('https://www.youtube.com/watch?v=DruvTra8swY')).rejects.toThrow()

    // The guard is the safety of the whole change: a re-download of a track
    // that is *already here* takes this same path, and deleting that row would
    // take away a song the user has had for weeks, with its bytes.
    // `removeSongIfEmpty` is what checks `file_uri`; nothing here decides.
    expect(mockRemoveIfEmpty).toHaveBeenCalled()
  })
})
