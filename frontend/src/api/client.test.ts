import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setAccessKey } from './accessKey'
import { apiFetch } from './client'

function okJson() {
  return { ok: true, status: 200, json: async () => ({}) } as Response
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('apiFetch access key', () => {
  it('omits X-Unlock-Key when none is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson())
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/songs')

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Unlock-Key']).toBeUndefined()
  })

  it('attaches X-Unlock-Key when one is stored', async () => {
    setAccessKey('secret-token')
    const fetchMock = vi.fn().mockResolvedValue(okJson())
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/songs')

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-Unlock-Key']).toBe('secret-token')
  })
})
