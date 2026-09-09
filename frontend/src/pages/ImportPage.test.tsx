import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  Page,
  PlaylistImport,
  SpotifyAccount,
  SpotifyPlaylist,
  SpotifyStatus,
} from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { ImportPage } from './ImportPage'

function makeAccount(overrides: Partial<SpotifyAccount> = {}): SpotifyAccount {
  return {
    id: 1,
    spotify_user_id: 'user-1',
    display_name: 'Alex',
    created_at: '2026-07-23T12:00:00Z',
    ...overrides,
  }
}

function makeStatus(overrides: Partial<SpotifyStatus> = {}): SpotifyStatus {
  return { configured: true, accounts: [], ...overrides }
}

function makePlaylist(overrides: Partial<SpotifyPlaylist> = {}): SpotifyPlaylist {
  return {
    id: 'pl-1',
    name: 'Road Trip',
    image_url: null,
    track_count: 12,
    owner_name: 'Alex',
    ...overrides,
  }
}

function makeImport(overrides: Partial<PlaylistImport> = {}): PlaylistImport {
  return {
    id: 7,
    service: 'spotify',
    account_id: 1,
    external_playlist_id: 'pl-1',
    name: 'Road Trip',
    status: 'review',
    track_count: 12,
    matched_count: 12,
    import_total: null,
    imported_count: 0,
    failed_count: 0,
    playlist_id: null,
    error: null,
    created_at: '2026-07-23T12:00:00Z',
    updated_at: '2026-07-23T12:00:00Z',
    ...overrides,
  }
}

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, limit: 20, offset: 0 }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

const fetchMock = vi.fn()

/** Route fetches by URL — the page hits status, playlists and imports. */
function routeFetch({
  status = makeStatus(),
  playlists = page<SpotifyPlaylist>([]),
  imports = page<PlaylistImport>([]),
}: {
  status?: SpotifyStatus
  playlists?: Page<SpotifyPlaylist>
  imports?: Page<PlaylistImport>
} = {}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return jsonResponse(undefined, 204)
    if (init?.method === 'POST') return jsonResponse(makeImport({ id: 99, status: 'queued' }), 201)
    if (url.startsWith('/api/access/status')) return jsonResponse({ locked: false, unlocked: true })
    if (url.startsWith('/api/spotify/status')) return jsonResponse(status)
    if (url.startsWith('/api/spotify/playlists')) return jsonResponse(playlists)
    if (url.startsWith('/api/playlist-imports')) return jsonResponse(imports)
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  routeFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fetchMock.mockReset()
})

describe('ImportPage', () => {
  it('explains when the backend has no Spotify configuration', async () => {
    routeFetch({ status: makeStatus({ configured: false }) })

    renderWithProviders(<ImportPage />)

    expect(await screen.findByText(/isn't set up on this server/i)).toBeInTheDocument()
  })

  it('offers a connect link that navigates to the backend login route', async () => {
    renderWithProviders(<ImportPage />)

    const link = await screen.findByRole('link', { name: 'Connect Spotify' })
    expect(link).toHaveAttribute('href', '/api/spotify/login')
  })

  it('lists connected accounts with a way to add another', async () => {
    routeFetch({ status: makeStatus({ accounts: [makeAccount()] }) })

    renderWithProviders(<ImportPage />)

    expect(await screen.findByText('Alex')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Connect another account' })).toHaveAttribute(
      'href',
      '/api/spotify/login',
    )
  })

  it('disconnects an account after confirming in the dialog', async () => {
    const user = userEvent.setup()
    routeFetch({ status: makeStatus({ accounts: [makeAccount()] }) })

    renderWithProviders(<ImportPage />)
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }))

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      expect(deletes[0][0]).toBe('/api/spotify/accounts/1')
    })
  })

  it('shows the playlist picker with a Liked Songs entry when connected', async () => {
    routeFetch({
      status: makeStatus({ accounts: [makeAccount()] }),
      playlists: page([makePlaylist()]),
    })

    renderWithProviders(<ImportPage />)

    expect(await screen.findByText('Liked Songs')).toBeInTheDocument()
    expect(screen.getByText('Road Trip')).toBeInTheDocument()
    expect(screen.getByText('12 tracks · by Alex')).toBeInTheDocument()
  })

  it('starts an import for the chosen playlist', async () => {
    const user = userEvent.setup()
    routeFetch({
      status: makeStatus({ accounts: [makeAccount()] }),
      playlists: page([makePlaylist()]),
    })

    renderWithProviders(<ImportPage />)
    // Scope to the "Road Trip" row so the query isn't confused by the other
    // "Import" buttons (Liked Songs, and the YouTube-playlist card).
    const row = (await screen.findByText('Road Trip')).closest('li')!
    await user.click(within(row).getByRole('button', { name: 'Import' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0][0]).toBe('/api/playlist-imports')
      expect(JSON.parse(posts[0][1].body)).toEqual({
        account_id: 1,
        playlist_id: 'pl-1',
        name: 'Road Trip',
      })
    })
  })

  it('starts a YouTube playlist import from a URL', async () => {
    const user = userEvent.setup()
    // No connected accounts, so the only "Import" button is the YouTube card's.
    renderWithProviders(<ImportPage />)

    await user.type(
      await screen.findByLabelText('Import a YouTube playlist'),
      'https://www.youtube.com/playlist?list=PL9',
    )
    await user.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([url, init]) =>
          init?.method === 'POST' && String(url).endsWith('/playlist-imports/youtube'),
      )
      expect(posts).toHaveLength(1)
      expect(JSON.parse(posts[0][1].body)).toEqual({
        url: 'https://www.youtube.com/playlist?list=PL9',
      })
    })
  })

  it('lists finished imports in a recent section, with links to their details', async () => {
    routeFetch({ imports: page([makeImport({ id: 7, name: 'Road Trip', status: 'done' })]) })

    renderWithProviders(<ImportPage />)

    const link = await screen.findByRole('link', { name: /road trip/i })
    expect(link).toHaveAttribute('href', '/import/7')
    expect(screen.getByText('Recent imports')).toBeInTheDocument()
    expect(screen.queryByText('In progress')).not.toBeInTheDocument()
  })

  it('surfaces an active import with a progress bar at the top', async () => {
    routeFetch({
      imports: page([
        makeImport({
          id: 7,
          name: 'Road Trip',
          status: 'matching',
          matched_count: 3,
          track_count: 12,
        }),
      ]),
    })

    renderWithProviders(<ImportPage />)

    expect(await screen.findByText('In progress')).toBeInTheDocument()
    expect(screen.queryByText('Recent imports')).not.toBeInTheDocument()
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '3')
    expect(bar).toHaveAttribute('aria-valuemax', '12')
    expect(screen.getByText('3 / 12')).toBeInTheDocument()
  })

  it('shows a success banner after the OAuth redirect and dismisses it', async () => {
    const user = userEvent.setup()

    renderWithProviders(<ImportPage />, { route: '/import?connected=1', path: '/import' })

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Spotify account connected.')

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows a friendly message for a known error slug', async () => {
    renderWithProviders(<ImportPage />, {
      route: '/import?spotify_error=access_denied',
      path: '/import',
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(/access was declined/i)
  })

  it('deletes an import record after confirming in the dialog', async () => {
    const user = userEvent.setup()
    routeFetch({ imports: page([makeImport({ id: 7, name: 'Road Trip' })]) })

    renderWithProviders(<ImportPage />)
    await user.click(await screen.findByRole('button', { name: 'Delete import Road Trip' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      const deletes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
      expect(deletes).toHaveLength(1)
      expect(deletes[0][0]).toBe('/api/playlist-imports/7')
    })
  })

  it('keeps the import when the dialog is cancelled', async () => {
    const user = userEvent.setup()
    routeFetch({ imports: page([makeImport({ id: 7, name: 'Road Trip' })]) })

    renderWithProviders(<ImportPage />)
    await user.click(await screen.findByRole('button', { name: 'Delete import Road Trip' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
