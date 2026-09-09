import { checkConnection } from '../src/api/connectionCheck'
import { useConnection } from '../src/api/connection'

/**
 * The four outcomes a user can hit. Each maps to different advice, so getting
 * the classification wrong sends the tester chasing the wrong problem.
 */

function respondWith(body: unknown, status = 200) {
  globalThis.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch
}

beforeEach(() => {
  useConnection.setState({ serverUrl: null, accessKey: null, loaded: true })
})

describe('checkConnection', () => {
  it('reports ok on an open server', async () => {
    respondWith({ locked: false, unlocked: true })

    await expect(checkConnection('192.168.1.10:8000', null)).resolves.toEqual({
      kind: 'ok',
      locked: false,
    })
  })

  it('reports ok on a locked server when the key is accepted', async () => {
    respondWith({ locked: true, unlocked: true })

    await expect(checkConnection('192.168.1.10:8000', 'good-key')).resolves.toEqual({
      kind: 'ok',
      locked: true,
    })
  })

  it('distinguishes a rejected key from an unreachable server', async () => {
    respondWith({ locked: true, unlocked: false })

    await expect(checkConnection('192.168.1.10:8000', 'bad-key')).resolves.toEqual({
      kind: 'keyRejected',
    })
  })

  it('accepts a locked server when no key was offered', async () => {
    // The gate gets in the way of nothing the app needs on first run: ADR-009
    // locks playlist import and search, never browsing or playback. Reporting
    // keyRejected here made the key mandatory and left the library unreachable,
    // since a key also scopes you to its own (empty) library under P12.
    respondWith({ locked: true, unlocked: false })

    await expect(checkConnection('192.168.1.10:8000', null)).resolves.toEqual({
      kind: 'ok',
      locked: true,
    })
  })

  it('reports unreachable when the request never lands', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as never

    await expect(checkConnection('192.168.1.10:8000', null)).resolves.toEqual({
      kind: 'unreachable',
    })
  })

  it('reports notAServer when something answers but is not MiO', async () => {
    // A router's admin page, say: reachable, wrong shape.
    respondWith({ hello: 'world' })

    await expect(checkConnection('192.168.1.10:8000', null)).resolves.toEqual({
      kind: 'notAServer',
    })
  })

  it('reports notAServer on an HTTP error, since something did answer', async () => {
    respondWith({ detail: 'Not Found' }, 404)

    await expect(checkConnection('192.168.1.10:8000', null)).resolves.toEqual({
      kind: 'notAServer',
    })
  })

  it('sends the candidate key, not the saved one', async () => {
    useConnection.setState({ serverUrl: 'http://old:8000', accessKey: 'old-key' })
    respondWith({ locked: true, unlocked: true })

    await checkConnection('192.168.1.10:8000', 'candidate-key')

    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe('http://192.168.1.10:8000/access/status')
    expect(init.headers['X-Unlock-Key']).toBe('candidate-key')
  })

  it('restores the saved connection afterwards, even on failure', async () => {
    useConnection.setState({ serverUrl: 'http://old:8000', accessKey: 'old-key' })
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('boom')) as never

    await checkConnection('192.168.1.10:8000', 'candidate-key')

    expect(useConnection.getState().serverUrl).toBe('http://old:8000')
    expect(useConnection.getState().accessKey).toBe('old-key')
  })
})
