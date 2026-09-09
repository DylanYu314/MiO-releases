import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import AddLocalScreen from '../app/(tabs)/add/local'
import type { LocalImportOutcome, LocalImportProgress } from '../src/library/localImport'
import '../src/i18n'

/**
 * The screen for adding tracks from phone storage (#325).
 *
 * The import itself is tested in `localImport.test.ts`; this covers what the
 * user is told. Which matters more than usual here, because the three outcomes
 * are genuinely different things — added, already had it, and could not read it
 * — and lumping them into one count would be the easy thing to build and
 * useless to act on.
 */

const mockPick = jest.fn()
const mockImport = jest.fn()

jest.mock('../src/library/localImport', () => ({
  pickLocalAudioFiles: (...args: unknown[]) => mockPick(...args),
  importLocalFiles: (...args: unknown[]) => mockImport(...args),
}))

// The screen itself does not navigate; the mock exists because expo-router
// touches native modules at import time.
jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn() }),
}))

function outcome(overrides: Partial<LocalImportOutcome> = {}): LocalImportOutcome {
  return {
    fileName: 'song.mp3',
    status: 'added',
    localId: 'local-1',
    title: 'Ceremony',
    error: null,
    ...overrides,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      // Both groups, per the recorded lesson: a `queries`-only setting leaves a
      // settled mutation's five-minute timer holding the worker open.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const renderScreen = () => render(<AddLocalScreen />, { wrapper })

beforeEach(() => {
  mockPick.mockReset().mockResolvedValue([{ name: 'song.mp3' }])
  mockImport.mockReset().mockResolvedValue([outcome()])
})

describe('picking files', () => {
  it('imports what the picker returned', async () => {
    const files = [{ name: 'a.mp3' }, { name: 'b.mp3' }]
    mockPick.mockResolvedValue(files)
    await renderScreen()

    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    await waitFor(() => expect(mockImport).toHaveBeenCalled())
    expect(mockImport.mock.calls[0][0]).toBe(files)
  })

  it('does nothing when the user backs out of the picker', async () => {
    mockPick.mockResolvedValue([])
    await renderScreen()

    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    expect(mockImport).not.toHaveBeenCalled()
  })

  it('leaves the previous summary alone when the picker is cancelled', async () => {
    /*
     * Backing out is an ordinary thing to do. Clearing the account of the last
     * run to say nothing about it would answer a question nobody asked and
     * destroy the one they might still be reading.
     */
    await renderScreen()
    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })
    await screen.findByText('Added 1 track.')

    mockPick.mockResolvedValue([])
    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    expect(screen.getByText('Added 1 track.')).toBeTruthy()
  })
})

describe('what the user is told afterwards', () => {
  it('counts what was added', async () => {
    mockImport.mockResolvedValue([outcome(), outcome({ fileName: 'b.mp3' })])
    await renderScreen()

    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    expect(await screen.findByText('Added 2 tracks.')).toBeTruthy()
  })

  it('says a duplicate was already there rather than calling it a failure', async () => {
    // The user did nothing wrong, and "you already have this" is the whole
    // answer — an error would send them looking for a problem that is not there.
    mockImport.mockResolvedValue([outcome({ status: 'duplicate', localId: null, title: null })])
    await renderScreen()

    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    expect(await screen.findByText('1 was already in your library.')).toBeTruthy()
    expect(screen.queryByText(/Added/)).toBeNull()
  })

  it('names each file that failed, and why', async () => {
    // "3 failed" is not something anyone can act on. The filename is the only
    // handle the user has on what they picked.
    mockImport.mockResolvedValue([
      outcome(),
      outcome({ fileName: 'broken.mp3', status: 'failed', error: 'No space left on device' }),
    ])
    await renderScreen()

    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    expect(await screen.findByText('broken.mp3 — No space left on device')).toBeTruthy()
    expect(screen.getByText('Added 1 track.')).toBeTruthy()
  })

  it('reports progress while the import runs', async () => {
    let report: ((progress: LocalImportProgress) => void) | undefined
    mockImport.mockImplementation(
      async (_files: unknown, options: { onProgress: (p: LocalImportProgress) => void }) => {
        report = options.onProgress
        return [outcome()]
      },
    )
    await renderScreen()

    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    // The callback the screen handed over is the one the import calls; driving
    // it here is what proves the line is wired to the run rather than to a
    // spinner that means nothing.
    await act(async () => {
      report?.({ current: 2, total: 5, fileName: 'third.flac' })
    })

    expect(screen.getByText('Adding 2 of 5 — third.flac')).toBeTruthy()
  })

  it('shows an error when the run itself breaks', async () => {
    mockImport.mockRejectedValue(new Error('database is locked'))
    await renderScreen()

    await act(async () => {
      fireEvent.press(screen.getByTestId('pick-local-files'))
    })

    expect(await screen.findByText('database is locked')).toBeTruthy()
  })
})
