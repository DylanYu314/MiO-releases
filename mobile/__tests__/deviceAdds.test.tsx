import { act, fireEvent, render, screen } from '@testing-library/react-native'

import {
  markInterrupted,
  resetDeviceAdds,
  useDeviceAdds,
  type DeviceAdd,
} from '../src/api/deviceAdds'
import {
  DeviceAddList,
  detailKeyFor,
  phaseKeyFor,
  showsAttempt,
  technicalDetail,
} from '../src/components/DeviceAddList'
import '../src/i18n'

/**
 * What this device tried to add, and how it went (#318).
 *
 * "if the user adds the link and quits before the track is downloaded…
 * when they come back they need to see what was added successfully, what
 * failed, and what was interrupted."
 *
 * Nothing recorded a device add at all — `useActiveImports` is keyed on a
 * numeric *server* job id, and the device path has none, so the add-link screen
 * kept the outcome in `useState` and leaving the screen lost it.
 */

const URL = 'https://www.youtube.com/watch?v=abc'

beforeEach(() => {
  resetDeviceAdds()
})

describe('recording an add', () => {
  it('remembers a link from the moment it starts, before anything is known', () => {
    useDeviceAdds.getState().started(URL, 'link')

    const [add] = useDeviceAdds.getState().adds
    expect(add).toMatchObject({ url: URL, source: 'link', status: 'working', title: null })
  })

  it('names it as soon as extraction answers', () => {
    useDeviceAdds.getState().started(URL, 'link')
    useDeviceAdds.getState().describe(URL, { title: '稻香', artist: '周杰倫', thumbnail: 'x.jpg' })

    expect(useDeviceAdds.getState().adds[0]).toMatchObject({ title: '稻香', artist: '周杰倫' })
  })

  it('treats a second attempt at the same link as the same record', () => {
    useDeviceAdds.getState().started(URL, 'link')
    useDeviceAdds.getState().failed(URL, 'refused')
    useDeviceAdds.getState().started(URL, 'link')

    // One pasted link is one thing the user is waiting on, however many
    // attempts it takes underneath — the judgement `useActiveImports` makes too.
    expect(useDeviceAdds.getState().adds).toHaveLength(1)
    expect(useDeviceAdds.getState().adds[0].status).toBe('working')
  })

  it('keeps the newest twenty', () => {
    for (let index = 0; index < 25; index++) {
      useDeviceAdds.getState().started(`${URL}${index}`, 'link')
    }

    expect(useDeviceAdds.getState().adds).toHaveLength(20)
    expect(useDeviceAdds.getState().adds[0].url).toBe(`${URL}24`)
  })

  it('clears the finished ones and leaves a run alone', () => {
    useDeviceAdds.getState().started(`${URL}1`, 'link')
    useDeviceAdds.getState().succeeded(`${URL}1`)
    useDeviceAdds.getState().started(`${URL}2`, 'link')

    useDeviceAdds.getState().clearFinished()

    expect(useDeviceAdds.getState().adds.map((add) => add.url)).toEqual([`${URL}2`])
  })
})

describe('an add that was interrupted', () => {
  it('is whatever was still working when the app started', () => {
    useDeviceAdds.getState().started(URL, 'link')

    // There is no moment at which the app can write "interrupted" — the process
    // is gone. A record still saying `working` at launch is the interrupted one.
    markInterrupted()

    expect(useDeviceAdds.getState().adds[0]).toMatchObject({
      status: 'failed',
      error: 'interrupted',
    })
  })

  it('leaves what already finished exactly as it was', () => {
    useDeviceAdds.getState().started(`${URL}1`, 'link')
    useDeviceAdds.getState().failed(`${URL}1`, 'no audio')
    useDeviceAdds.getState().started(`${URL}2`, 'link')
    useDeviceAdds.getState().succeeded(`${URL}2`)
    // A third, still running — without one the sweep returns early and this
    // test cannot see what it does. Mutation testing found exactly that: a
    // sweep that rewrote *every* record passed here.
    useDeviceAdds.getState().started(`${URL}3`, 'link')

    markInterrupted()

    const byUrl = Object.fromEntries(useDeviceAdds.getState().adds.map((add) => [add.url, add]))
    expect(byUrl[`${URL}1`].error).toBe('no audio')
    expect(byUrl[`${URL}2`].status).toBe('done')
    expect(byUrl[`${URL}3`].error).toBe('interrupted')
  })

  it('reads as its own thing, not as a failure', () => {
    // Nothing was wrong with the link; the app was killed while it downloaded.
    // "Failed" would send someone looking for a fault that is not there.
    expect(
      detailKeyFor({
        url: URL,
        source: 'link',
        status: 'failed',
        title: null,
        artist: null,
        thumbnail: null,
        error: 'interrupted',
        startedAt: 0,
        finishedAt: 1,
      }),
    ).toBe('interrupted')
  })
})

describe('the list on the page', () => {
  it('shows only the adds made from that page', async () => {
    useDeviceAdds.getState().started(`${URL}1`, 'link')
    useDeviceAdds.getState().describe(`${URL}1`, { title: 'From the link page', artist: 'A' })
    useDeviceAdds.getState().started(`${URL}2`, 'search')
    useDeviceAdds.getState().describe(`${URL}2`, { title: 'From search', artist: 'B' })

    await render(<DeviceAddList source="link" />)

    // "What did I add here" is the question being asked, so each page answers
    // for itself.
    expect(screen.getByText('From the link page')).toBeTruthy()
    expect(screen.queryByText('From search')).toBeNull()
  })

  /**
   * The **kind**, not the debugging string (#441).
   *
   * "Download refused with status 403 at byte 0" is a good diagnostic and no
   * use to somebody deciding whether to try again — which is the only question
   * a failed row raises.
   */
  it('says what kind of failure it was, and then how (#582)', async () => {
    /*
     * ⚠️ **This reverses half of #441, deliberately and with my approval**
     * (2026-08-17).
     *
     * #441's ordering stands and is asserted first: the *kind* leads, because
     * "is this worth trying again" is the one thing a user wants from a
     * failure. What #441 also did was drop the raw message entirely, and with
     * it the status and the byte offset — so "The source refused the download"
     * was the same sentence for a 403 at byte 0, a 403 after the first
     * megabyte, and a timeout eight megabytes in. Three faults, three
     * different answers, one indistinguishable row.
     *
     * That is why bug 1 of the 2026-08-17 report could not be diagnosed. The
     * detail is a second, quieter line now — ignorable, and there.
     */
    useDeviceAdds.getState().started(URL, 'link')
    useDeviceAdds.getState().describe(URL, { title: 'A Long Track', artist: 'A' })
    await act(async () => {
      useDeviceAdds
        .getState()
        .failed(URL, 'Download was short: 10764208 of 14587885 bytes', 'timed_out')
    })

    await render(<DeviceAddList source="link" />)

    expect(screen.getByText(/Ran out of time/)).toBeTruthy()
    expect(screen.getByText(/10764208/)).toBeTruthy()
  })

  it('does not print the same sentence twice', async () => {
    // A record with no kind already shows its message as the *main* line
    // (#441's fallback for entries written before kinds existed). Repeating it
    // underneath would be the detail line making the display worse.
    useDeviceAdds.getState().started(URL, 'link')
    await act(async () => {
      useDeviceAdds.getState().failed(URL, 'something old and unclassified')
    })

    await render(<DeviceAddList source="link" />)

    expect(screen.getAllByText('something old and unclassified')).toHaveLength(1)
  })

  it('shows no technical line for a failure that has no message', async () => {
    // `technicalDetail` returns null rather than an empty row, so a failure
    // recorded with a kind and nothing else does not gain a blank second line.
    useDeviceAdds.getState().started(URL, 'link')
    await act(async () => {
      useDeviceAdds.getState().failed(URL, null, 'offline')
    })

    await render(<DeviceAddList source="link" />)

    expect(screen.getByText(/No connection/)).toBeTruthy()
    expect(technicalDetail(useDeviceAdds.getState().adds[0], 'No connection.')).toBeNull()
  })

  it('does not print the same sentence twice (#653)', async () => {
    /*
     * `messageFor` translates some failures before writing them to the record,
     * so for those `add.error` **is** the main line. `technicalDetail` returned
     * it regardless, and the row printed the reason twice — which I saw on
     * my own failing add on 2026-08-20:
     *
     *     YouTube refused the download before sending anything. …
     *     YouTube refused the download before sending anything. …
     *
     * ⚠️ The bug predates #639 and has always affected region-locked videos;
     * #639 added a second translated case that is common, which is what made it
     * visible. The docblock claimed this exclusion existed the whole time.
     */
    useDeviceAdds.getState().started(URL, 'link')
    await act(async () => {
      useDeviceAdds
        .getState()
        .failed(
          URL,
          'YouTube refused the download before sending anything. It has cleared on its own every time so far — try again in a few minutes.',
          'refused_at_start',
        )
    })

    await render(<DeviceAddList source="link" />)

    expect(screen.getAllByText(/refused the download before sending anything/)).toHaveLength(1)
  })

  it('still shows a raw message the kind does not already say (#582)', async () => {
    // The other edge, and the reason #582 put the second line there: a status
    // and a byte offset tell apart three faults the kind flattens into one.
    useDeviceAdds.getState().started(URL, 'link')
    await act(async () => {
      useDeviceAdds
        .getState()
        .failed(URL, 'Download refused with status 403 at byte 2097152', 'refused')
    })

    await render(<DeviceAddList source="link" />)

    expect(screen.getByText(/The source refused the download/)).toBeTruthy()
    expect(screen.getByText('Download refused with status 403 at byte 2097152')).toBeTruthy()
  })

  it('names the service that actually refused, not always YouTube', async () => {
    /*
     * #565 — the bug I hit with the source set to Bilibili.
     *
     * `VideoUnavailable` is thrown by **both** extractors: `bilibili.ts` throws
     * it for codes -404, -403, 62002 and 62004. The `unavailable` copy said
     * "YouTube will not play this one here" whatever the link was, so a
     * Bilibili video Bilibili had removed came back as YouTube's refusal — and
     * the advice that follows it, "another source may work", pointed at the
     * source the user had already chosen.
     *
     * Asserted **both ways**. A test that only checked the Bilibili row would
     * pass against a string that had simply stopped naming anything.
     */
    const bilibili = 'https://www.bilibili.com/video/BV1GJ411x7h7'
    useDeviceAdds.getState().started(bilibili, 'link')
    useDeviceAdds.getState().started(URL, 'link')
    await act(async () => {
      useDeviceAdds.getState().failed(bilibili, 'Bilibili: 稿件不可见', 'unavailable')
      useDeviceAdds.getState().failed(URL, 'gone', 'unavailable')
    })

    await render(<DeviceAddList source="link" />)

    expect(screen.getByText(/^Bilibili will not play this one here/)).toBeTruthy()
    expect(screen.getByText(/^YouTube will not play this one here/)).toBeTruthy()
  })

  it('falls back to the message for a record written before kinds existed', async () => {
    useDeviceAdds.getState().started(URL, 'link')
    await act(async () => {
      useDeviceAdds.getState().failed(URL, 'something old and unclassified')
    })

    await render(<DeviceAddList source="link" />)

    // Persisted records rehydrate without a kind. Showing nothing would be
    // worse than showing the old string.
    expect(screen.getByText('something old and unclassified')).toBeTruthy()
  })

  it('shows the link until the track has a name', async () => {
    useDeviceAdds.getState().started(URL, 'link')

    await render(<DeviceAddList source="link" />)

    // A record with no title is still a record of something, and the link is
    // what the user pasted.
    expect(screen.getByText(URL)).toBeTruthy()
  })

  it('says an interrupted add was interrupted', async () => {
    useDeviceAdds.getState().started(URL, 'link')
    markInterrupted()

    await render(<DeviceAddList source="link" />)

    expect(screen.getByText(/Interrupted/)).toBeTruthy()
  })

  it('offers a retry for a failed one, with the link it needs', async () => {
    const onRetry = jest.fn()
    useDeviceAdds.getState().started(URL, 'link')
    useDeviceAdds.getState().failed(URL, 'no audio')

    await render(<DeviceAddList source="link" onRetry={onRetry} />)
    await act(async () => {
      fireEvent.press(screen.getByText('Try again'))
    })

    // The record is the memory now, not the text box — so trying again works
    // for a link pasted days ago.
    expect(onRetry).toHaveBeenCalledWith(URL)
  })

  it('draws nothing at all when this page has added nothing', async () => {
    useDeviceAdds.getState().started(URL, 'search')

    await render(<DeviceAddList source="link" />)

    expect(screen.queryByText('Added from here')).toBeNull()
  })
})

/**
 * A slow add saying it is slow, rather than spinning (#430).
 *
 * `importToDevice` walks four YouTube clients and each attempt's download is
 * bounded at five minutes, so a bare spinner can honestly sit there for twenty
 * minutes. I waited "so long" on one while Diagnostics filled with refusals
 * behind it — the record could only say `working`, so a slow add and a stuck one
 * were the same thing on screen.
 */
describe('what a working record can say about itself', () => {
  const working = (over: Partial<DeviceAdd> = {}): DeviceAdd => ({
    url: URL,
    source: 'link',
    status: 'working',
    title: null,
    artist: null,
    thumbnail: null,
    error: null,
    startedAt: 0,
    finishedAt: null,
    ...over,
  })

  it('names the step it is on', () => {
    expect(phaseKeyFor(working({ phase: 'extracting' }))).toBe('extracting')
    expect(phaseKeyFor(working({ phase: 'downloading' }))).toBe('downloading')
    expect(phaseKeyFor(working({ phase: 'saving' }))).toBe('saving')
  })

  it('falls back to the generic line rather than showing nothing', () => {
    // Two real cases: a record rehydrated from a build before this existed, and
    // the moment between `started` and the first report.
    expect(phaseKeyFor(working())).toBe('working')
  })

  it('hides the attempt counter on the first attempt and shows it after', () => {
    // On the first it is noise on every ordinary add. From the second it is the
    // whole point — it is what separates working through the client chain from
    // having stopped.
    expect(showsAttempt(working({ attempt: 1, attempts: 4 }))).toBe(false)
    expect(showsAttempt(working({ attempt: 2, attempts: 4 }))).toBe(true)
  })

  it('never shows an attempt counter on a finished record', () => {
    expect(showsAttempt(working({ status: 'failed', attempt: 3, attempts: 4 }))).toBe(false)
  })

  it('records the step as the import reports it', () => {
    useDeviceAdds.getState().started(URL, 'link')
    useDeviceAdds.getState().progressed(URL, { phase: 'downloading', attempt: 2, attempts: 4 })

    expect(useDeviceAdds.getState().adds[0]).toMatchObject({
      phase: 'downloading',
      attempt: 2,
      attempts: 4,
    })
  })

  it('drops the step when the add finishes, so a done row cannot say "downloading"', () => {
    useDeviceAdds.getState().started(URL, 'link')
    useDeviceAdds.getState().progressed(URL, { phase: 'downloading', attempt: 1, attempts: 4 })
    useDeviceAdds.getState().succeeded(URL)

    expect(useDeviceAdds.getState().adds[0].phase).toBeNull()
  })
})
