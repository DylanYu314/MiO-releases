import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import AddLinkScreen from '../app/(tabs)/add/link'
import { useConnection } from '../src/api/connection'
import { useDeviceAdds } from '../src/api/deviceAdds'
import { resetSharedText, useSharedText } from '../src/library/sharedText'
import '../src/i18n'

const mockImportToDevice = jest.fn()
jest.mock('../src/library/deviceImport', () => ({
  importToDevice: (...args: unknown[]) => mockImportToDevice(...args),
}))

// Asking Bilibili what parts a video has, before importing anything (#575).
const mockListParts = jest.fn()
jest.mock('../src/library/bilibili', () => ({
  listBilibiliParts: (...args: unknown[]) => mockListParts(...args),
}))

const mockImportParts = jest.fn()
jest.mock('../src/library/bilibiliImport', () => ({
  importBilibiliPartsOnDevice: (...args: unknown[]) => mockImportParts(...args),
}))

const mockPush = jest.fn()
jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: (...args: unknown[]) => mockPush(...args), replace: jest.fn() }),
}))

/**
 * Add-link, after the server route left it (#320).
 *
 * This screen has exactly one path now: the phone fetches the audio itself.
 * Everything to do with `POST /jobs` — the websocket, `JobProgress`, the
 * recent-jobs list, the retry — moved to `bilibili.test.tsx` along with the
 * screen it belongs to, and those tests are unchanged apart from what they
 * render, which is what "re-homed, not deleted" is supposed to look like.
 */

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      // `gcTime` under `queries` does NOT cover mutations — a trap this repo has already paid for. A
      // settled mutation's collection timer once held a jest worker open for
      // five minutes on a green run.
      mutations: { gcTime: 0 },
    },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  mockPush.mockReset()
  useDeviceAdds.setState({ adds: [] })
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: null,
    usingDefaultServer: true,
    loaded: true,
  })
})

describe('downloading on this device (#246)', () => {
  /** A wrapper whose client can be watched, so "the library refreshes" is
   *  testable rather than assumed. */
  function spyWrapper() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
    })
    const invalidate = jest.spyOn(client, 'invalidateQueries')
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    return { Wrapper, invalidate }
  }

  beforeEach(() => {
    mockImportToDevice.mockReset().mockResolvedValue({
      local_id: 'abc',
      title: 'Flower of Japan',
      artist: 'A Channel',
      client: 'IOS',
    })
  })

  it('imports without going anywhere near the server', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch

    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText('Link to import'),
        'https://www.youtube.com/watch?v=DruvTra8swY',
      )
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add'))
    })

    await waitFor(() =>
      expect(mockImportToDevice).toHaveBeenCalledWith(
        'https://www.youtube.com/watch?v=DruvTra8swY',
        // Which page it came from, so the record lands on the right list (#318).
        { source: 'link' },
      ),
    )
    // The point of the whole change: no POST /jobs, no server in the path.
    expect(globalThis.fetch).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByText('"Flower of Japan" is on this device.')).toBeTruthy(),
    )
  })

  it('refreshes the library, without which the song is invisible', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch
    const { Wrapper, invalidate } = spyWrapper()

    await render(<AddLinkScreen />, { wrapper: Wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), 'https://youtu.be/DruvTra8swY')
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add'))
    })

    // Exactly the failure I hit: the download succeeded, the app said
    // "added to the library", and the library showed nothing — because the
    // list was never told to re-read the device.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['local-library'] }))
  })

  it('shows why it failed rather than swallowing it', async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch
    mockImportToDevice.mockRejectedValue(new Error('No client could provide audio for dQw4w9WgXcQ'))

    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), 'https://youtu.be/dQw4w9WgXcQ')
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add'))
    })

    // A failure that says nothing is what made #177 expensive to diagnose.
    await waitFor(() =>
      expect(screen.getByText('No client could provide audio for dQw4w9WgXcQ')).toBeTruthy(),
    )
  })
})

/**
 * Bilibili is fetched here now (#492).
 *
 * This screen used to refuse a Bilibili link and point at the server page. The
 * phone can do it itself — three unauthenticated requests and a `buvid3` cookie
 * — so the refusal is gone and the routing happens inside `importToDevice`.
 */
describe('a link pasted inside other text (#573)', () => {
  /*
   * Nothing shares a bare URL. Every share sheet and "copy link" button hands
   * over a sentence, and add-link validated with `new URL(input)` — so all of
   * these were refused and the user had to edit the text down by hand on a
   * phone keyboard.
   *
   * This is the JavaScript half of #573. The Android share **target** needs a
   * manifest intent filter, which moves the native fingerprint and would block
   * every pending OTA behind a build — so it is deliberately not here.
   */
  beforeEach(() => {
    mockImportToDevice.mockReset().mockResolvedValue({ title: 'A song' })
  })

  const submit = async (text: string) => {
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), text)
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add'))
    })
  }

  it('imports the link out of a sentence', async () => {
    await submit('Check out this video https://youtu.be/dQw4w9WgXcQ')

    expect(mockImportToDevice).toHaveBeenCalledWith(
      'https://youtu.be/dQw4w9WgXcQ',
      expect.anything(),
    )
  })

  it('does not offer the server page for text that holds a link it can fetch', async () => {
    // The notice is driven by the same extraction, so a pasted sentence must
    // not read as "this site needs the server".
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText('Link to import'),
        'Check out this video https://youtu.be/dQw4w9WgXcQ',
      )
    })

    expect(screen.queryByText(/needs the server/)).toBeNull()
  })

  it('picks the link this phone can fetch, not merely the first one', async () => {
    // Share text routinely carries a tracking wrapper before the real link.
    await submit('via https://example.com/tracker?to=x — https://youtu.be/dQw4w9WgXcQ')

    expect(mockImportToDevice).toHaveBeenCalledWith(
      'https://youtu.be/dQw4w9WgXcQ',
      expect.anything(),
    )
  })

  it('still refuses text with nothing importable in it', async () => {
    // The control. Reading a link out of prose must not turn into accepting
    // anything at all.
    await submit('just some words')

    expect(mockImportToDevice).not.toHaveBeenCalled()
  })
})

describe('a link shared in from another app (#573)', () => {
  beforeEach(() => {
    resetSharedText()
    mockImportToDevice.mockReset().mockResolvedValue({ title: 'A song' })
  })

  it('pre-fills the box rather than importing straight away', async () => {
    /*
     * 2026-08-17: *"prefill is fine"*. It is also the safer half — a
     * share sheet is easy to hit by accident and #246's imports are not free —
     * and it is what makes the multi-part picker (#575) work for a shared
     * Bilibili link with no extra wiring, because the ordinary Add button runs.
     */
    useSharedText.getState().offer('Check out this https://youtu.be/dQw4w9WgXcQ')

    await render(<AddLinkScreen />, { wrapper })

    // The link, extracted from the sentence — the two halves of #573 meeting.
    expect(screen.getByLabelText('Link to import').props.value).toBe(
      'Check out this https://youtu.be/dQw4w9WgXcQ',
    )
    expect(mockImportToDevice).not.toHaveBeenCalled()
  })

  it('consumes it, so coming back does not re-fill the box', async () => {
    // The reason this is a store and not a route parameter: a param survives a
    // re-render and a back-navigation, and the user would meet the same link
    // again every time they returned.
    useSharedText.getState().offer('https://youtu.be/dQw4w9WgXcQ')

    await render(<AddLinkScreen />, { wrapper })
    expect(useSharedText.getState().pending).toBeNull()
  })

  it('leaves the box alone when nothing was shared', async () => {
    await render(<AddLinkScreen />, { wrapper })

    expect(screen.getByLabelText('Link to import').props.value).toBe('')
  })
})

describe('a Bilibili link', () => {
  const BILIBILI = 'https://www.bilibili.com/video/BV1xx411c7mD'

  /** One part — an ordinary video, which must behave exactly as it always has. */
  const single = {
    bvid: 'BV1xx411c7mD',
    title: 'A song',
    parts: [{ page: 1, title: 'A song', durationSeconds: 214, url: BILIBILI }],
  }

  /** Three parts — Bilibili's 多P, and the case #575 exists for. */
  const album = {
    bvid: 'BV1xx411c7mD',
    title: 'The Whole Album',
    parts: [
      { page: 1, title: 'Show You', durationSeconds: 178, url: `${BILIBILI}` },
      { page: 2, title: 'Find Me', durationSeconds: 188, url: `${BILIBILI}?p=2` },
      { page: 3, title: 'Want U 2', durationSeconds: 183, url: `${BILIBILI}?p=3` },
    ],
  }

  const paste = async () => {
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), BILIBILI)
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add'))
    })
  }

  beforeEach(() => {
    mockImportToDevice.mockReset().mockResolvedValue({ title: 'A song' })
    mockListParts.mockReset().mockResolvedValue(single)
    mockImportParts.mockReset().mockResolvedValue({ saved: 0, failed: 0 })
    globalThis.fetch = jest.fn() as unknown as typeof fetch
  })

  it('is accepted rather than sent to the server page', async () => {
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), BILIBILI)
    })

    expect(screen.queryByText(/needs the server/)).toBeNull()
  })

  it('asks which parts when the video has more than one (#575)', async () => {
    /*
     * *"yes we asked, and we allow user to select which episodes, or
     * select all"*.
     *
     * It asks rather than importing everything because 多P is not only used for
     * albums — a ninety-minute lecture split into six parts is the same shape,
     * and importing all of it unasked puts six long tracks in someone's library
     * because they pasted one link.
     */
    mockListParts.mockResolvedValue(album)

    await paste()

    expect(await screen.findByText('The Whole Album')).toBeTruthy()
    expect(screen.getByText('Find Me')).toBeTruthy()
    // Nothing is fetched until the question is answered.
    expect(mockImportToDevice).not.toHaveBeenCalled()
    expect(mockImportParts).not.toHaveBeenCalled()
  })

  it('imports every part when the sheet is confirmed as it opens', async () => {
    // Everything starts selected, because "all of it" is the answer for an
    // album and the work should be deselecting the odd track.
    mockListParts.mockResolvedValue(album)

    await paste()
    await act(async () => {
      fireEvent.press(await screen.findByText('Import 3 parts'))
    })

    expect(mockImportParts).toHaveBeenCalledTimes(1)
    expect(mockImportParts.mock.calls[0][0].parts.map((p: { page: number }) => p.page)).toEqual([
      1, 2, 3,
    ])
  })

  it('imports only what is left ticked', async () => {
    mockListParts.mockResolvedValue(album)

    await paste()
    await act(async () => {
      fireEvent.press(await screen.findByLabelText('Deselect Find Me'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Import 2 parts'))
    })

    expect(mockImportParts.mock.calls[0][0].parts.map((p: { page: number }) => p.page)).toEqual([
      1, 3,
    ])
  })

  it('sends a single chosen part down the ordinary path, with no playlist', async () => {
    /*
     * ⚠️ **One part is not a list.** The list loop makes a playlist, and a lone
     * track has never made one on this screen — so choosing exactly one must
     * behave like pasting a link to it, which is what the user just did.
     */
    mockListParts.mockResolvedValue(album)

    await paste()
    await act(async () => {
      fireEvent.press(await screen.findByText('Clear'))
    })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Want U 2'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Import 1 part'))
    })

    expect(mockImportParts).not.toHaveBeenCalled()
    expect(mockImportToDevice).toHaveBeenCalledWith(
      'https://www.bilibili.com/video/BV1xx411c7mD?p=3',
      expect.anything(),
    )
  })

  it('does not ask about a video with only one part', async () => {
    // A sheet with one row is a question with no answer.
    await paste()

    expect(screen.queryByText(/Choose which ones/)).toBeNull()
    expect(mockImportToDevice).toHaveBeenCalled()
  })

  it('still imports when Bilibili will not say what the parts are', async () => {
    /*
     * A listing failure must not be fatal. The ordinary import may well
     * succeed, and refusing to try because a question could not be asked would
     * turn a working add into a dead end.
     */
    mockListParts.mockRejectedValue(new Error('Bilibili answered code -412'))

    await paste()

    await waitFor(() =>
      expect(mockImportToDevice).toHaveBeenCalledWith(BILIBILI, expect.anything()),
    )
  })

  it('is imported on this device, like any other link', async () => {
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), BILIBILI)
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add'))
    })

    // The screen does not choose an extractor: `importToDevice` routes on the
    // URL, which is what gave every other caller Bilibili for free.
    expect(mockImportToDevice).toHaveBeenCalledWith(
      BILIBILI,
      expect.objectContaining({
        source: 'link',
      }),
    )
  })
})

/**
 * A link the device cannot fetch (#320).
 *
 * `canImportOnDevice` existed and was never called here, so anything the phone
 * could not handle was accepted by the button and failed with a raw
 * `NotAYouTubeLink` — a message naming an internal class, offering nothing to
 * do about it. Since #492 the phone handles two sites, so this is about
 * everything else.
 */
describe('a link the device cannot fetch', () => {
  const UNSUPPORTED = 'https://soundcloud.com/x/y'

  beforeEach(() => {
    mockImportToDevice.mockReset()
    globalThis.fetch = jest.fn() as unknown as typeof fetch
  })

  it('says so before the attempt, rather than failing afterwards', async () => {
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), UNSUPPORTED)
    })

    expect(
      screen.getByText('This phone can fetch from YouTube and Bilibili. It cannot read that link.'),
    ).toBeTruthy()
    expect(mockImportToDevice).not.toHaveBeenCalled()
  })

  it('offers no page to take it to, because there is none (#637)', async () => {
    /*
     * ⚠️ This test used to assert the opposite — that the notice sent the user
     * to `/add/bilibili`, "rather than leaving a dead end". That page handed the
     * link to `POST /jobs` on a server, and after #613 the app ships without
     * one and after #614 the endpoint needs an access key on a server the user
     * runs themselves. The dead end moved: the offer became the dead end.
     */
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), UNSUPPORTED)
    })

    expect(screen.queryByText(/server page/)).toBeNull()
    expect(mockPush).not.toHaveBeenCalledWith('/add/bilibili')
  })

  it('will not import it even if the button is pressed', async () => {
    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Link to import'), 'https://soundcloud.com/x/y')
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add'))
    })

    // The button is disabled, and `addOnDevice` guards again anyway — the
    // record's retry calls straight in with a URL this screen never validated.
    expect(mockImportToDevice).not.toHaveBeenCalled()
  })

  it('refuses a retry from the record too, where the button cannot guard it', async () => {
    /*
     * The reason `addOnDevice` checks as well as the button, and the mutation
     * that survived until this test existed.
     *
     * `DeviceAddList`'s retry calls straight in with a URL from days ago that
     * this screen never validated — a record left over from before #320, when
     * a Bilibili link could be submitted here. Guarding only the button leaves
     * that path open.
     */
    useDeviceAdds.setState({
      adds: [
        {
          url: 'https://soundcloud.com/x/y',
          source: 'link',
          status: 'failed',
          title: null,
          artist: null,
          thumbnail: null,
          error: 'nope',
          startedAt: 1,
          finishedAt: 2,
        },
      ],
    })

    await render(<AddLinkScreen />, { wrapper })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Try adding https://soundcloud.com/x/y again'))
    })

    expect(mockImportToDevice).not.toHaveBeenCalled()
  })

  it('says nothing about an empty box, which is not wrong, just empty', async () => {
    await render(<AddLinkScreen />, { wrapper })

    expect(screen.queryByText(/That link needs the server/)).toBeNull()
  })

  it("does not promise the server's reach (#374)", async () => {
    await render(<AddLinkScreen />, { wrapper })

    // The standing description outlived the screen it described: it promised
    // "YouTube, Bilibili, or any other supported site", downloaded "in the
    // background", which is the *server* route and left in #320. The hint that
    // replaced it names the two sites this phone actually has extractors for —
    // which since #492 does include Bilibili, so the check is on the promise
    // rather than on the word.
    expect(screen.queryByText(/any other supported site/)).toBeNull()
    expect(screen.queryByText(/in the background/)).toBeNull()
    // What is left in its place is true of this screen.
    expect(
      screen.getByText(
        'Fetches the audio straight to your phone, without the server. YouTube and Bilibili links.',
      ),
    ).toBeTruthy()
  })
})
