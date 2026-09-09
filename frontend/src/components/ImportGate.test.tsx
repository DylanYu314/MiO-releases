import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '../test/renderWithProviders'
import { ImportGate } from './ImportGate'

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

const fetchMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  localStorage.clear()
})

describe('ImportGate', () => {
  it('renders its children when importing is not locked', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ locked: false, unlocked: true }))

    renderWithProviders(
      <ImportGate>
        <p>import controls</p>
      </ImportGate>,
    )

    expect(await screen.findByText('import controls')).toBeInTheDocument()
  })

  it('locks the feature and unlocks it once a valid key is entered', async () => {
    // The gate is satisfied only when the stored key is "good".
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        localStorage.getItem('mio-access-key') === 'good'
          ? { locked: true, unlocked: true }
          : { locked: true, unlocked: false },
      ),
    )

    renderWithProviders(
      <ImportGate>
        <p>import controls</p>
      </ImportGate>,
    )

    expect(await screen.findByText('Importing is locked')).toBeInTheDocument()
    expect(screen.queryByText('import controls')).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Importing is locked'), 'good')
    await userEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(await screen.findByText('import controls')).toBeInTheDocument()
  })
})
