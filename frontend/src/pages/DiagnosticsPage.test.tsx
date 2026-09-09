import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientError } from '../api/clientErrors'
import type { Page } from '../api/types'
import { renderWithProviders } from '../test/renderWithProviders'
import { DiagnosticsPage } from './DiagnosticsPage'

/**
 * The reader (#322).
 *
 * `GET /client-errors` has answered since #136 with nothing anywhere calling
 * it. This page is that missing half, so what is worth pinning is that it asks
 * the right question and shows the answer — including the fields that say
 * *which device*, without which a report from one of several testers is not
 * actionable.
 */

function makeReport(overrides: Partial<ClientError> = {}): ClientError {
  return {
    id: 1,
    platform: 'android',
    owner_install_id: 1,
    message: 'playback.failed: no such file',
    stack: null,
    description: null,
    app_version: '1.0.0',
    os_version: '34',
    device: 'Pixel 7',
    level: 'error',
    created_at: '2026-08-06T12:00:00Z',
    ...overrides,
  }
}

function page(items: ClientError[], total = items.length): Page<ClientError> {
  return { items, total, limit: 50, offset: 0 }
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Every URL the page asks for, so an unexpected one fails loudly.
 *
 *  `access/status` is routed explicitly and defaults to **admin**. It is not
 *  decoration: the page is admin-gated since #354, and leaving that request
 *  unmocked let it fail silently — which reads as "no admin" now and as "not
 *  locked" under the first version of the gate, quietly disabling it. */
function routeFetch(
  result: Page<ClientError>,
  access = { locked: true, unlocked: true, admin: true },
) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/access/status')) return jsonResponse(access)
    if (url.startsWith('/api/client-errors')) return jsonResponse(result)
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

describe('DiagnosticsPage', () => {
  it('lists what the clients reported', async () => {
    routeFetch(page([makeReport()]))

    renderWithProviders(<DiagnosticsPage />)

    expect(await screen.findByText('playback.failed: no such file')).toBeInTheDocument()
  })

  it('says which device a report came from', async () => {
    routeFetch(page([makeReport()]))

    renderWithProviders(<DiagnosticsPage />)

    // A report from one of several testers is only actionable if you know
    // whose it is.
    expect(
      await screen.findByText('android · Pixel 7 · v1.0.0 · 34 · install #1'),
    ).toBeInTheDocument()
  })

  it('asks the server for one level when a filter is chosen', async () => {
    routeFetch(page([makeReport()]))

    renderWithProviders(<DiagnosticsPage />)
    await screen.findByText('playback.failed: no such file')
    await userEvent.click(screen.getByRole('button', { name: 'Errors' }))

    // Filtered server-side, not in the browser: the page holds 50 of what may
    // be thousands of rows, so filtering what arrived would hide the rest.
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([url]) => url as string)
      expect(urls.some((url) => url.includes('level=error'))).toBe(true)
    })
  })

  it('returns to the first page when the filter changes', async () => {
    // Page 3 of "all" is not page 3 of "errors" — keeping the offset would
    // land on an empty page and read as "there are none".
    routeFetch(page([makeReport()], 500))

    renderWithProviders(<DiagnosticsPage />)
    await screen.findByText('playback.failed: no such file')
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => (url as string).includes('offset=50'))).toBe(
        true,
      ),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Errors' }))

    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1)?.[0] as string
      expect(last).toContain('level=error')
      expect(last).not.toContain('offset=50')
    })
  })

  it('keeps a stack behind a disclosure so it cannot bury the next row', async () => {
    routeFetch(page([makeReport({ stack: 'at PlayerHost (PlayerHost.tsx:42)' })]))

    renderWithProviders(<DiagnosticsPage />)

    const summary = await screen.findByText('Stack trace')
    expect(summary.closest('details')).not.toHaveAttribute('open')
  })

  it('says when there is nothing at this level', async () => {
    routeFetch(page([]))

    renderWithProviders(<DiagnosticsPage />)

    expect(await screen.findByText('Nothing logged yet.')).toBeInTheDocument()
  })

  it('says so when the reports cannot be loaded', async () => {
    // Only the reports fail. Failing `access/status` too would be a different
    // test — the gate would close first and the error would never render.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/access/status')) {
        return jsonResponse({ locked: true, unlocked: true, admin: true })
      }
      return jsonResponse({ detail: 'nope' }, 500)
    })

    renderWithProviders(<DiagnosticsPage />)

    expect(await screen.findByText('Could not load the reports.')).toBeInTheDocument()
  })
})

describe('who can read it (#354)', () => {
  /*
   * Each denial test asserts that the reports are **never requested**, not that
   * they are absent from the screen.
   *
   * The screen assertion is a race, and it silently passed a broken gate. While
   * the access-status request is in flight the gate is closed and its message is
   * already rendered, so `findByText('Administrator access required')` resolves
   * on the *loading* state — instantly, in 6 ms — and `queryByText(report)` is
   * absent simply because nothing has loaded yet. Both assertions passed with
   * the gate keyed on `unlocked` instead of `admin`, which is the exact bug they
   * were written to catch.
   *
   * "The request was never made" has no such window: it is true at the end of
   * the test or it is not, and the page not fetching what it may not show is a
   * stronger property than the page not painting it.
   */
  async function reportsRequested(): Promise<boolean> {
    // Let every queued query settle first, so this is not just early.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    return fetchMock.mock.calls.some(([url]) => (url as string).startsWith('/api/client-errors'))
  }

  it('never even asks for the reports from a browser with no key', async () => {
    routeFetch(page([makeReport()]), { locked: true, unlocked: false, admin: false })

    renderWithProviders(<DiagnosticsPage />)

    expect(await reportsRequested()).toBe(false)
    expect(screen.getByText('Administrator access required')).toBeInTheDocument()
  })

  it('never asks for them with an ordinary tester key, which is the bug I caught', async () => {
    // Unlocked but not admin: every invited tester is in exactly this state.
    // The first version of this gate keyed on `unlocked` and would have shown
    // them everyone else's crash reports.
    routeFetch(page([makeReport()]), { locked: true, unlocked: true, admin: false })

    renderWithProviders(<DiagnosticsPage />)

    expect(await reportsRequested()).toBe(false)
    expect(screen.getByText('Administrator access required')).toBeInTheDocument()
  })

  it('never asks for them when the server is not enforcing the import gate at all', async () => {
    // An open import gate says nothing about who may read diagnostics.
    routeFetch(page([makeReport()]), { locked: false, unlocked: true, admin: false })

    renderWithProviders(<DiagnosticsPage />)

    expect(await reportsRequested()).toBe(false)
  })

  it('shows them to an administrator', async () => {
    routeFetch(page([makeReport()]), { locked: true, unlocked: true, admin: true })

    renderWithProviders(<DiagnosticsPage />)

    expect(await screen.findByText('playback.failed: no such file')).toBeInTheDocument()
  })

  it('says which install sent a report, not just which phone model', async () => {
    routeFetch(page([makeReport({ owner_install_id: 3 })]))

    renderWithProviders(<DiagnosticsPage />)

    // Two testers on the same handset are otherwise indistinguishable.
    expect(await screen.findByText(/install #3/)).toBeInTheDocument()
  })
})
