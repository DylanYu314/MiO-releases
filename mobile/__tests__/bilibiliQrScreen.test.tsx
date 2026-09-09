import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { ReactNode } from 'react'

import BilibiliFavouritesScreen from '../app/(tabs)/add/import/bilibili'
import { useDiagnostics } from '../src/diagnostics/log'
import {
  BilibiliHandoffUnreadable,
  resetBilibiliAuthForTests,
  type QrStatus,
} from '../src/library/bilibiliAuth'
import * as auth from '../src/library/bilibiliAuth'
import '../src/i18n'

/**
 * What the QR login screen writes down (2026-08-15).
 *
 * ## The bug this exists for
 *
 * *"it says the code expired, require new code… no error log caught."*
 * The second half is what made the first half undiagnosable, and it was one
 * empty `catch {}` in the poll loop.
 *
 * The failure it hid has a specific shape, and it produces that exact report:
 *
 *   1. the user confirms the scan, and Bilibili answers `data.code: 0`
 *   2. the hand-off URL is unreadable, so `pollQrLogin` throws
 *   3. **the key is now spent** — a confirmed code answers `86038` afterwards
 *   4. two seconds later the next poll gets `86038`, and the screen honestly
 *      says "expired"
 *
 * Every visible symptom is of step 4 and the cause is at step 2. So these tests
 * are about step 2 leaving a record, not about the screen's rendering.
 *
 * ⚠️ The credential never passes through the log. `bilibiliAuth.ts` logs
 * nothing at all (`bilibiliCredentialNeverLogged.test.ts` holds that line), so
 * the shape travels here on a typed error carrying a length and the parameter
 * names — which is what the last test checks.
 */

jest.mock('react-native-qrcode-svg', () => 'QRCode')

/** Two seconds is `POLL_MS`; the loop is a `setInterval`. */
const POLL_MS = 2000

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

/** Render, get to the QR, then let the poll fire exactly once. */
async function signInAndPollOnce() {
  await render(<BilibiliFavouritesScreen />, { wrapper })
  await act(async () => {
    fireEvent.press(screen.getByText('Sign in with QR code'))
  })
  await act(async () => {
    jest.advanceTimersByTime(POLL_MS)
  })
}

const entries = () => useDiagnostics.getState().entries
const detailOf = (event: string) => entries().find((entry) => entry.event === event)?.detail

let poll: jest.SpiedFunction<typeof auth.pollQrLogin>

beforeEach(() => {
  jest.useFakeTimers()
  resetBilibiliAuthForTests()
  useDiagnostics.setState({ entries: [], lastUploadedAt: null })

  jest.spyOn(auth, 'loadBilibiliCredential').mockResolvedValue(null)
  jest.spyOn(auth, 'startQrLogin').mockResolvedValue({
    url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=abc',
    qrcodeKey: 'abc',
  })
  poll = jest.spyOn(auth, 'pollQrLogin')
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

it('records the answer each poll came back with', async () => {
  poll.mockResolvedValue({ state: 'waiting' } as QrStatus)

  await signInAndPollOnce()

  expect(detailOf('bilibili.qr.poll')).toBe('state=waiting')
})

it('writes down a confirmed scan that could not be read, which used to be silent', async () => {
  poll.mockRejectedValue(
    new BilibiliHandoffUnreadable('https://passport.biligame.com/c?gourl=x&Expires=1'),
  )

  await signInAndPollOnce()

  expect(detailOf('bilibili.qr.unreadable')).toBe(
    'handoffLength=49 keys=[gourl Expires] cookies=[]',
  )
})

it('tells an unreadable hand-off apart from the network being down', async () => {
  poll.mockRejectedValue(new Error('Network request failed'))

  await signInAndPollOnce()

  // Different name, because they ask for different things: one is Bilibili
  // changing shape, the other is a phone on the wrong network.
  expect(detailOf('bilibili.qr.pollFailed')).toBe('Network request failed')
  expect(entries().map((entry) => entry.event)).not.toContain('bilibili.qr.unreadable')
})

it('never lets a credential reach the log', async () => {
  poll.mockRejectedValue(
    new BilibiliHandoffUnreadable(
      'https://passport.biligame.com/c?SESSDATA=abc%2Cdef&bili_jct=jjj',
    ),
  )

  await signInAndPollOnce()

  const written = entries()
    .map((entry) => `${entry.event} ${entry.detail ?? ''}`)
    .join(' ')
  expect(written).toContain('keys=[SESSDATA bili_jct]')
  expect(written).not.toContain('abc,def')
  expect(written).not.toContain('jjj')
})
