/**
 * A failed update check must not look like being up to date (#776).
 *
 * ⛔ **This whole path used to be an empty `catch`.** Its comment was right that
 * `checkForUpdateAsync` throws on every development build and whenever the
 * network is gone, and wrong about what to do with that: a real failure was
 * discarded with the harmless ones, and the screen then said *up to date* — the
 * one lie `useAppUpdates`'s own docblock says must never be told.
 *
 * It also made #774 undiagnosable. A user reporting "updates never arrive"
 * produced no line anywhere, so three explanations could not be separated and
 * the investigation was closed unresolved.
 *
 * ⚠️ **The class name is the half that matters.** #303 took five builds to learn
 * it: `session_blocked` said nothing and `session_blocked:<ExceptionClass>` was
 * the whole answer. So these assert on the name reaching the log, not merely
 * that *something* was logged.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { useEffect, useState } from 'react'
import { Pressable, Text } from 'react-native'

import { logWarn, useDiagnostics } from '../src/diagnostics/log'
import { LATEST_VERSION_URLS } from '../src/updates/latestVersion'
import { useAppUpdates } from '../src/updates/useAppUpdates'

const mockUseUpdates = jest.fn()
const mockCheckForUpdateAsync = jest.fn()
const mockFetchUpdateAsync = jest.fn()
let mockIsEnabled = true

jest.mock('expo-updates', () => ({
  get useUpdates() {
    return mockUseUpdates
  },
  get isEnabled() {
    return mockIsEnabled
  },
  checkForUpdateAsync: (...args: unknown[]) => mockCheckForUpdateAsync(...args),
  fetchUpdateAsync: (...args: unknown[]) => mockFetchUpdateAsync(...args),
  reloadAsync: jest.fn().mockResolvedValue(undefined),
}))

const mockFetchLatestVersion = jest.fn()
jest.mock('../src/updates/latestVersion', () => ({
  ...jest.requireActual('../src/updates/latestVersion'),
  fetchLatestVersion: (...args: unknown[]) => mockFetchLatestVersion(...args),
}))

jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }))

type Outcome = string | null
let outcome: Outcome = null

/**
 * ⚠️ The hook is captured in an **effect**, not assigned during render.
 *
 * Reassigning a module-level variable in the render body is what
 * `react-hooks/globals` forbids — it is a side effect during render — and the
 * rule's own message says to do it in an effect instead. CI caught that after a
 * local `npm run lint | tail -1` hid the `1 error` line behind the warning
 * summary; reading the whole summary is the fix for that half.
 *
 * ⚠️ Driving it by a button press instead looked tidier and does not work here:
 * `render` is already wrapped in `act`, so pressing in the same tick gives
 * "overlapping act() calls" and the render never settles.
 */
let check: (() => Promise<void>) | null = null

function Probe() {
  const updates = useAppUpdates()
  useEffect(() => {
    check = async () => {
      outcome = await updates.checkNow()
    }
  }, [updates])
  return <Text>probe</Text>
}

/** The same hook, plus a way to force a re-render without remounting. */
function Rerenderable() {
  const [, bump] = useState(0)
  useAppUpdates()
  return (
    <Pressable accessibilityLabel="rerender" onPress={() => bump((n) => n + 1)}>
      <Text>rerender</Text>
    </Pressable>
  )
}

/** Renders the hook and runs one deliberate check. */
async function checkNow() {
  render(<Probe />)
  await waitFor(() => expect(check).not.toBeNull())
  await check!()
}

const events = () => useDiagnostics.getState().entries.map((entry) => entry.event)
const detailFor = (event: string) =>
  useDiagnostics.getState().entries.find((entry) => entry.event === event)?.detail ?? ''

beforeEach(() => {
  jest.clearAllMocks()
  outcome = null
  check = null
  mockIsEnabled = true
  useDiagnostics.setState({ entries: [] })
  mockUseUpdates.mockReturnValue({ downloadedUpdate: undefined })
  mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: false })
  mockFetchUpdateAsync.mockResolvedValue(undefined)
  // Up to date on the APK side, so every assertion below is about the JS half.
  mockFetchLatestVersion.mockResolvedValue({ versionName: '1.0.0', versionCode: 1, url: 'u' })
})

describe('a deliberate check', () => {
  it('names the error class when the check itself throws', async () => {
    mockCheckForUpdateAsync.mockRejectedValue(new TypeError('Network request failed'))

    await checkNow()

    expect(events()).toContain('updates.jsCheckFailed')
    expect(detailFor('updates.jsCheckFailed')).toContain('TypeError')
    expect(detailFor('updates.jsCheckFailed')).toContain('Network request failed')
  })

  it('distinguishes a failed download from a failed check', async () => {
    // ⭐ The distinction #774 needed and could not make: the manifest and the
    // bundle come from different hosts, so being told "yes there is an update"
    // and actually getting it fail independently.
    mockCheckForUpdateAsync.mockResolvedValue({ isAvailable: true })
    mockFetchUpdateAsync.mockRejectedValue(new Error('asset download failed'))

    await checkNow()

    expect(events()).toContain('updates.jsFetchFailed')
    expect(events()).not.toContain('updates.jsCheckFailed')
  })

  it('does not claim the app is up to date when the check failed', async () => {
    mockCheckForUpdateAsync.mockRejectedValue(new Error('nope'))

    await checkNow()

    expect(outcome).toBe('unreachable')
  })

  it('still reports up to date when the check genuinely succeeded', async () => {
    // The control. Without it, "never says upToDate" would pass against a hook
    // that can no longer report success at all.
    await checkNow()

    expect(outcome).toBe('upToDate')
    expect(events()).not.toContain('updates.jsCheckFailed')
  })

  it('says nothing at all when updates are disabled', async () => {
    // Every development build. The original empty `catch` was right that this
    // is not worth reporting — a log full of noise is read as often as no log.
    mockIsEnabled = false
    mockCheckForUpdateAsync.mockRejectedValue(new Error('updates are disabled'))

    await checkNow()

    expect(events()).not.toContain('updates.jsCheckFailed')
    expect(events()).not.toContain('updates.jsFetchFailed')
    expect(outcome).toBe('upToDate')
    expect(mockCheckForUpdateAsync).not.toHaveBeenCalled()
  })

  it('reports when no host could answer about a new APK', async () => {
    mockFetchLatestVersion.mockResolvedValue(null)

    await checkNow()

    expect(events()).toContain('updates.apkCheckFailed')
    // ⚠️ A count, not the URLs: `scrub()` rewrites any URL to `<url>` (#354), so
    // a line listing the hosts would store `<url>, <url>` and say nothing.
    //
    // ⚠️ Derived from the constant, not hardcoded. Writing `2` here was wrong —
    // there are three hosts — and a literal would go stale the next time one is
    // added, in a test whose subject is a number.
    expect(detailFor('updates.apkCheckFailed')).toContain(`${LATEST_VERSION_URLS.length} tried`)
    expect(LATEST_VERSION_URLS.length).toBeGreaterThan(1)
    expect(outcome).toBe('unreachable')
  })
})

describe('the automatic on-launch check', () => {
  it('reports a failure nobody pressed a button to cause', async () => {
    // ⛔ The hole that mattered most: almost nobody presses *check for updates*,
    // so this is the path a silently-never-updating app actually takes.
    mockUseUpdates.mockReturnValue({
      downloadedUpdate: undefined,
      checkError: new TypeError('Network request failed'),
    })

    render(<Probe />)

    await waitFor(() => expect(events()).toContain('updates.autoCheckFailed'))
    expect(detailFor('updates.autoCheckFailed')).toContain('TypeError')
  })

  it('distinguishes a failed automatic download from a failed automatic check', async () => {
    mockUseUpdates.mockReturnValue({
      downloadedUpdate: undefined,
      downloadError: new Error('bundle 403'),
    })

    render(<Probe />)

    await waitFor(() => expect(events()).toContain('updates.autoFetchFailed'))
    expect(events()).not.toContain('updates.autoCheckFailed')
  })

  it('logs a persistent failure once rather than on every render', async () => {
    // ⚠️ Re-rendered by pressing a button that bumps state, not by the render
    // result's `rerender` — this project's `render` returns an opaque object and
    // `guardedRouter.test.tsx` re-renders the same way.
    const error = new TypeError('Network request failed')
    mockUseUpdates.mockReturnValue({ downloadedUpdate: undefined, checkError: error })

    render(<Rerenderable />)
    await waitFor(() => expect(events()).toContain('updates.autoCheckFailed'))
    // ⚠️ `await act`, not a bare `fireEvent.press`. The diagnostics log is a
    // zustand store wrapped in `persist`, and an unawaited write to one breaks
    // the *next* test rather than this one — which is exactly what happened:
    // the following test's mount effect stopped running, and the failure looked
    // like it belonged to that test.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('rerender'))
    })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('rerender'))
    })

    expect(events().filter((e) => e === 'updates.autoCheckFailed')).toHaveLength(1)
  })

  it('still logs once when expo-updates hands back a fresh error object', async () => {
    // ⛔ Written because two earlier attempts could not kill a mutant, and each
    // failure said something.
    //
    // Deleting the hook's `reported` ref left the suite green, because the
    // effect's dependency array already stops it re-running on an unrelated
    // re-render — so a test that merely re-renders measures React, not the hook.
    // And `logEvent` drops an *immediate* repeat, so a test without another
    // event in between measures the log.
    //
    // The case where the ref is the only thing doing the work is this one: a
    // **new Error object with the same message on every render**, which is what
    // a library returning `new Error(...)` from a hook produces. Then the deps
    // change identity, the effect really does re-run, and something else has
    // been logged in between so the log will not absorb it either.
    mockUseUpdates.mockImplementation(() => ({
      downloadedUpdate: undefined,
      checkError: new TypeError('Network request failed'),
    }))

    render(<Rerenderable />)
    await waitFor(() => expect(events()).toContain('updates.autoCheckFailed'))

    logWarn('something.else', 'breaks the immediate-repeat window')
    await act(async () => {
      fireEvent.press(screen.getByLabelText('rerender'))
    })

    expect(events().filter((event) => event === 'updates.autoCheckFailed')).toHaveLength(1)
  })

  it('says nothing when the automatic check is healthy', async () => {
    // ⚠️ The control is inside the test. Waiting on "nothing was logged" would
    // pass just as well against a mount effect that never ran — the shape this
    // repo keeps paying for. So the APK side is made to log something, and only
    // once that line proves the effect executed is the absence of the others
    // worth anything.
    mockFetchLatestVersion.mockResolvedValue({ versionName: '9.9.9', versionCode: 99, url: 'u' })

    render(<Probe />)

    await waitFor(() => expect(events()).toContain('updates.apkAvailable'))
    expect(events()).not.toContain('updates.autoCheckFailed')
    expect(events()).not.toContain('updates.autoFetchFailed')
  })
})
