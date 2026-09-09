import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Text } from 'react-native'

import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { useConnection } from '../src/api/connection'
import '../src/i18n'

/**
 * #136: without a boundary, a render crash in a production build leaves a blank
 * screen — no red box, no message, nothing a non-technical tester can describe.
 */

function Boom(): never {
  throw new Error('undefined is not an object')
}

beforeEach(() => {
  useConnection.setState({
    serverUrl: 'https://mio.test/api',
    accessKey: null,
    usingDefaultServer: true,
    loaded: true,
  })
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ id: 1 }),
  })) as unknown as typeof fetch
  // React logs caught errors to console.error; the boundary working is the
  // point, so the noise is not.
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('ErrorBoundary (#136)', () => {
  it('shows something a person can read instead of a blank screen', async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Something went wrong')).toBeTruthy()
    // And the message, quietly, for whoever is sitting next to them.
    expect(screen.getByText('undefined is not an object')).toBeTruthy()
  })

  it('reports the crash without being asked', async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    // A tester who force quits rather than typing is the likely case, so the
    // report cannot depend on them pressing anything.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    const [url, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(url).toContain('/client-errors')
    const body = JSON.parse(init.body)
    expect(body.message).toBe('undefined is not an object')
    expect(body.platform).toBeTruthy()
  })

  it('sends what the user typed, when they type it', async () => {
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    ;(globalThis.fetch as jest.Mock).mockClear()

    await act(async () => {
      fireEvent.changeText(
        screen.getByLabelText('What were you doing?'),
        'I pressed play and it froze',
      )
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Send this too'))
    })

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled())
    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    // The only field a person wrote, and usually the most useful one.
    expect(JSON.parse(init.body).description).toBe('I pressed play and it froze')
    await waitFor(() => expect(screen.getByText('Sent, thank you')).toBeTruthy())
  })

  it('does not claim to have sent a report that failed', async () => {
    // The server being unreachable is *likely* at the moment something has gone
    // wrong. Saying "sent" anyway trains a tester to stop bothering.
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    globalThis.fetch = jest.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    await act(async () => {
      fireEvent.press(screen.getByText('Send this too'))
    })

    expect(screen.queryByText('Sent, thank you')).toBeNull()
  })

  it('reporting a crash cannot cause one', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch

    // An unhandled rejection inside an error handler is how a recoverable
    // screen becomes a dead app.
    await render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByText('Something went wrong')).toBeTruthy()
  })

  it('renders its children when nothing is wrong', async () => {
    await render(
      <ErrorBoundary>
        <Text>All fine</Text>
      </ErrorBoundary>,
    )

    expect(screen.getByText('All fine')).toBeTruthy()
    expect(screen.queryByText('Something went wrong')).toBeNull()
  })
})
