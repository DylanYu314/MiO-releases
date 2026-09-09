import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SpotifyConnectCard } from '../components/SpotifyConnectCard'
import { PlaylistDetailPage } from '../pages/PlaylistDetailPage'
import { renderWithProviders } from '../test/renderWithProviders'
import i18n from './index'

/**
 * The two strings that embed markup go through <Trans>, where a placeholder
 * naming a component that isn't passed renders as nothing — silently losing
 * the whole sentence. That only showed up in an e2e run, so it gets a unit
 * test: these assert the surrounding prose survives interpolation.
 */
describe('<Trans> strings', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await i18n.changeLanguage('en')
  })

  it('renders the Spotify not-configured message with its <code> spans', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ configured: false, accounts: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    vi.stubGlobal('fetch', vi.fn(fetchMock))

    renderWithProviders(<SpotifyConnectCard />)

    expect(await screen.findByText(/isn't set up on this server/i)).toBeInTheDocument()
    expect(screen.getByText('SPOTIFY_CLIENT_ID')).toBeInTheDocument()
    expect(screen.getByText('backend/.env')).toBeInTheDocument()
  })

  it('renders the empty-playlist message with a link to the library', async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ id: 1, name: 'Empty', items: [] }), {
        headers: { 'Content-Type': 'application/json' },
      })
    vi.stubGlobal('fetch', vi.fn(fetchMock))

    renderWithProviders(<PlaylistDetailPage />, { route: '/playlists/1', path: '/playlists/:id' })

    expect(await screen.findByText(/this playlist is empty/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'library' })).toHaveAttribute('href', '/')
  })

  it('keeps the interpolated markup in Chinese too', async () => {
    await i18n.changeLanguage('zh')
    // The placeholders are named, so a translator reordering the sentence
    // can't break them — assert the Chinese copy still carries all three.
    const message = i18n.t('spotify.notConfigured')
    expect(message).toContain('<code>SPOTIFY_CLIENT_ID</code>')
    expect(message).toContain('<code>backend/.env</code>')
    expect(i18n.t('playlistDetail.empty')).toContain('<library>')
  })
})
