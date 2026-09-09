import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SearchResult } from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { SearchPage } from './SearchPage'

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    url: 'https://youtu.be/abc',
    title: 'Never Gonna Give You Up',
    uploader: 'Rick Astley',
    duration: 213,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

const fetchMock = vi.fn()
let searchResults: SearchResult[] = []

/** The page also probes /access/status (the import gate); keep it unlocked. */
function routeFetch() {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/access/status'))
      return jsonResponse({ locked: false, unlocked: true })
    if (init?.method === 'POST') return jsonResponse({ id: 3 }, 201)
    if (String(url).includes('/search')) return jsonResponse(searchResults)
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

function searchCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/search'))
}

beforeEach(() => {
  searchResults = []
  vi.stubGlobal('fetch', fetchMock)
  routeFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

describe('SearchPage', () => {
  it('does not search until a query is submitted', () => {
    renderWithProviders(<SearchPage />)
    expect(searchCalls()).toHaveLength(0)
  })

  it('searches on submit and lists the results', async () => {
    searchResults = [makeResult({ title: 'Song One' })]

    renderWithProviders(<SearchPage />)
    await userEvent.type(screen.getByLabelText('Search'), 'rick astley')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('Song One')).toBeInTheDocument()
    const url = searchCalls()[0][0] as string
    expect(url).toContain('/search?')
    expect(url).toContain('q=rick+astley')
    expect(url).toContain('platform=youtube')
  })

  it('restores a search from the URL, so it survives navigation', async () => {
    searchResults = [makeResult({ title: 'From URL' })]

    renderWithProviders(<SearchPage />, { route: '/search?q=rick&platform=youtube' })

    expect(await screen.findByText('From URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Search')).toHaveValue('rick')
    expect(searchCalls()[0][0]).toContain('q=rick')
  })

  it('adds a result by starting an import job, then marks it added', async () => {
    searchResults = [makeResult()]

    renderWithProviders(<SearchPage />)
    await userEvent.type(screen.getByLabelText('Search'), 'rick')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }))

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0][0]).toBe('/api/jobs')
      expect(JSON.parse(posts[0][1].body)).toEqual({ url: 'https://youtu.be/abc' })
    })
    expect(await screen.findByRole('button', { name: 'Added' })).toBeDisabled()
  })

  it('shows an empty state when there are no results', async () => {
    searchResults = []

    renderWithProviders(<SearchPage />)
    await userEvent.type(screen.getByLabelText('Search'), 'nothing here')
    await userEvent.click(screen.getByRole('button', { name: 'Search' }))

    expect(await screen.findByText('No results found.')).toBeInTheDocument()
  })
})
