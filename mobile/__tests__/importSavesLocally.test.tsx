import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import { useActiveImports } from '../src/api/activeImports'
import { useConnection } from '../src/api/connection'
import { loadInstallId } from '../src/api/installId'
import { ImportProgressPanel } from '../src/components/ImportProgressPanel'
import '../src/i18n'

/** The panel invalidates the local library after a handover (#216), so it
 *  needs a client — `gcTime: 0` on both groups, per this repo's conventions. */
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/**
 * An import is not finished when the server says so (#159).
 *
 * Under local-first the song is in the library when its audio is on *this
 * device*. These pin the handover: a `done` job triggers a fetch of the row and
 * a download of the file, and the entry stays visibly in flight until that
 * lands.
 */

const mockSave = jest.fn()
jest.mock('../src/library/songs', () => ({
  saveSongToDevice: (...args: unknown[]) => mockSave(...args),
  // The handover skips a song whose audio is already here (#215), so it reads
  // the local row first — by the server's id, since this device mints its own
  // (#246). Nothing is on the device in these tests.
  getLocalSongByServerId: async () => null,
}))

const mockJob = { current: null as unknown }
const mockCreateJob = jest.fn()
jest.mock('../src/api/jobs', () => ({
  // Keyed on the id: a retry creates a *new* job, and a mock that hands the
  // same failed job back for every id makes the retry look like it failed too.
  useJob: (jobId: number) => ({
    data:
      mockJob.current && (mockJob.current as { id: number }).id === jobId ? mockJob.current : null,
  }),
  // The panel retries a transient failure itself (#222), so it creates jobs now.
  useCreateJob: () => ({ mutate: mockCreateJob }),
}))

jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
}))

beforeEach(async () => {
  // The startup gate (#190) guarantees this has resolved before any screen
  // mounts, so a test that skips it would be testing a state the app cannot be
  // in — and would then "prove" the header is optional.
  await loadInstallId()
  mockSave.mockReset().mockResolvedValue(undefined)
  mockJob.current = null
  mockCreateJob.mockReset().mockImplementation((_url, options) => options?.onSuccess?.({ id: 99 }))
  useActiveImports.setState({ imports: [] })
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: 'a-key',
    usingDefaultServer: true,
    loaded: true,
  })
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 5, title: 'Downloaded', artist: 'A' }),
  })) as unknown as typeof fetch
})

function trackOne() {
  useActiveImports.setState({
    imports: [
      {
        jobId: 7,
        url: 'https://youtube.com/watch?v=x',
        status: null,
        savedLocally: false,
        startedAt: 1,
        retries: 0,
      },
    ],
  })
}

describe('an import finishes on the device, not on the server (#159)', () => {
  it('downloads the song once the server job is done', async () => {
    trackOne()
    mockJob.current = { id: 7, status: 'done', song_id: 5 }

    await render(<ImportProgressPanel />, { wrapper })

    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    const [song, context] = mockSave.mock.calls[0]
    expect(song.id).toBe(5)
    // Without the install header the audio endpoint 404s.
    expect(context.headers['X-Install-Id']).toBeDefined()
    expect(context.serverUrl).toBe('https://mio.test/api')
  })

  it('marks it saved, which is what takes it out of the panel', async () => {
    trackOne()
    mockJob.current = { id: 7, status: 'done', song_id: 5 }

    await render(<ImportProgressPanel />, { wrapper })

    await waitFor(() => expect(useActiveImports.getState().imports[0].savedLocally).toBe(true))
  })

  it('leaves it unfinished when the download fails, so the next launch retries', async () => {
    trackOne()
    mockJob.current = { id: 7, status: 'done', song_id: 5 }
    mockSave.mockRejectedValue(new Error('offline'))

    await render(<ImportProgressPanel />, { wrapper })

    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    // Swallowing the error *and* marking it saved would lose the song silently.
    await act(async () => {})
    expect(useActiveImports.getState().imports[0].savedLocally).toBe(false)
  })

  it('does not download again for an import already saved', async () => {
    useActiveImports.setState({
      imports: [
        { jobId: 7, url: 'x', status: 'done', savedLocally: true, startedAt: 1, retries: 0 },
      ],
    })
    mockJob.current = { id: 7, status: 'done', song_id: 5 }

    await render(<ImportProgressPanel />, { wrapper })
    await act(async () => {})

    // The flag is persisted, so this is what stops a relaunch re-downloading
    // everything ever imported.
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('does nothing while the server is still working', async () => {
    trackOne()
    mockJob.current = { id: 7, status: 'downloading', song_id: null }

    await render(<ImportProgressPanel />, { wrapper })
    await act(async () => {})

    expect(mockSave).not.toHaveBeenCalled()
  })
})

describe('a transient failure is our problem first (#222)', () => {
  /** Starts in flight, as a real one does: the watcher mounts, then the job
   *  data turns the record failed. Seeding it already-failed would skip the
   *  path being tested. */
  function trackedWith(retries: number) {
    useActiveImports.setState({
      imports: [
        {
          jobId: 7,
          url: 'https://youtu.be/x',
          status: null,
          savedLocally: false,
          startedAt: 1,
          retries,
        },
      ],
    })
  }

  it('re-submits the link itself, and the record follows the new job', async () => {
    trackedWith(0)
    mockJob.current = { id: 7, status: 'failed', song_id: null, error_code: 'bot_check' }

    await render(<ImportProgressPanel />, { wrapper })

    await waitFor(() =>
      expect(mockCreateJob).toHaveBeenCalledWith('https://youtu.be/x', expect.anything()),
    )
    // One pasted link is one thing the user is waiting on, however many
    // attempts it takes underneath — so the record moves, it does not multiply.
    const imports = useActiveImports.getState().imports
    expect(imports).toHaveLength(1)
    expect(imports[0]).toMatchObject({ jobId: 99, retries: 1 })
  })

  it('does not retry a failure that will fail identically forever', async () => {
    trackedWith(0)
    mockJob.current = { id: 7, status: 'failed', song_id: null, error_code: 'private' }

    await render(<ImportProgressPanel />, { wrapper })
    await act(async () => {})

    // A private video is a fact, not a bad moment. Retrying wastes the user's
    // time and tells them nothing.
    expect(mockCreateJob).not.toHaveBeenCalled()
  })

  it('stops once the budget is spent, leaving it to the user', async () => {
    trackedWith(2)
    mockJob.current = { id: 7, status: 'failed', song_id: null, error_code: 'bot_check' }

    await render(<ImportProgressPanel />, { wrapper })
    await act(async () => {})

    // The backend already tried three times inside the task; a link that has
    // failed that and two of ours will not come good on a sixth.
    expect(mockCreateJob).not.toHaveBeenCalled()
  })
})
