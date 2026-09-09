import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Clipboard, Linking, Share } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

import DiagnosticsScreen from '../app/diagnostics'
import * as client from '../src/api/client'
import { useConnection } from '../src/api/connection'
import { logError, logInfo, logWarn, useDiagnostics } from '../src/diagnostics/log'
import * as report from '../src/diagnostics/report'
import i18n from '../src/i18n'
import { loadInstallId } from '../src/api/installId'

/**
 * The Diagnostics screen (#322).
 *
 * For a tester in the field who has just seen something go wrong: read what the
 * app recorded, and send it now rather than waiting for tomorrow's handshake.
 */

jest.mock('react-native/Libraries/Components/Clipboard/Clipboard', () => ({
  __esModule: true,
  // `react-native`'s index exposes Clipboard through a getter that returns this
  // module's `default`, so the mock has to sit there rather than on the module.
  default: { setString: jest.fn() },
}))

let apiFetch: jest.SpyInstance

beforeEach(async () => {
  jest.clearAllMocks()
  await AsyncStorage.clear()
  await i18n.changeLanguage('en')
  useDiagnostics.setState({ entries: [], lastUploadedAt: null })
  apiFetch = jest.spyOn(client, 'apiFetch')
  jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' })
})

afterEach(() => {
  apiFetch.mockRestore()
  // ⚠️ `jest.replaceProperty` is NOT undone by `clearAllMocks` — only by a
  // restore. Without this, a test that blanks `REPORT_FORM_URL` leaves it blank
  // for every test after it, and the one asserting a URL *is* configured fails
  // in a file it never touched.
  jest.restoreAllMocks()
})

describe('DiagnosticsScreen', () => {
  it('tells the user which install this is, so they can quote it', async () => {
    // Every report is stored against this install. A bug report saying "it
    // broke on my phone" is only findable among several testers if it can say
    // *which* phone (#354).
    await loadInstallId()

    await render(<DiagnosticsScreen />)

    expect(screen.getByText(/This device:/)).toBeTruthy()
    expect(screen.getByText(/install [0-9a-f]{8}/)).toBeTruthy()
  })

  it('shows which server the app is talking to (#374)', async () => {
    // Moved here out of Settings, where an ordinary tester had no use for it.
    // "The server is wrong" is a bug report, and this is the bug-report screen.
    useConnection.setState({
      serverUrl: 'https://mio.test/api',
      accessKey: null,
      usingDefaultServer: false,
      loaded: true,
    })

    await render(<DiagnosticsScreen />)

    expect(screen.getByText('Server: https://mio.test/api')).toBeTruthy()
  })

  it('says there is no server rather than printing a blank line (#613)', async () => {
    /*
     * ⚠️ Replaces "falls back to the shipped address". There is no shipped
     * address any more — MiO ships pointing at nothing — so the old fallback
     * would render `Server: ` and make the one question this line exists to
     * answer unanswerable, which is what its own comment warned against.
     */
    useConnection.setState({
      serverUrl: null,
      accessKey: null,
      usingDefaultServer: true,
      loaded: true,
    })

    await render(<DiagnosticsScreen />)

    expect(screen.getByText('No server — everything stays on this device.')).toBeTruthy()
    expect(screen.queryByText('Server: ')).toBeNull()
  })

  it('says so when nothing has been logged', async () => {
    await render(<DiagnosticsScreen />)

    expect(screen.getByText('Nothing logged yet.')).toBeTruthy()
  })

  it('shows the newest entry first', async () => {
    logInfo('import.started', 'first')
    logInfo('import.succeeded', 'second')

    await render(<DiagnosticsScreen />)

    // The thing you came here to see is the thing that just went by.
    const rows = screen.getAllByText(/^import\./)
    expect(rows.map((row) => row.props.children)).toEqual(['import.succeeded', 'import.started'])
  })

  it('narrows to one level, because a day of log buries three crashes', async () => {
    logInfo('import.started')
    logError('playback.failed', 'no such file')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByText('Errors'))
    })

    expect(screen.getByText('playback.failed')).toBeTruthy()
    expect(screen.queryByText('import.started')).toBeNull()
  })

  it('copies a report and keeps the log readable afterwards', async () => {
    /*
     * ⚠️ The screen used to go **blank** on a successful send (#566), because
     * the upload deleted what the server acknowledged. Preparing a report must
     * not resurrect that: the user pressed the button precisely because they
     * were looking at something.
     */
    logInfo('a')
    logWarn('b')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByTestId('copy-report'))
    })

    await waitFor(() =>
      expect(
        screen.getByText('Report copied. Paste it wherever you are reporting the problem.'),
      ).toBeTruthy(),
    )
    expect(Clipboard.setString).toHaveBeenCalledTimes(1)
    // The report is the log, not a summary of it.
    const copied = (Clipboard.setString as jest.Mock).mock.calls[0][0] as string
    expect(copied).toContain('MiO problem report')
    expect(copied).toContain('a')
    expect(copied).toContain('b')

    expect(useDiagnostics.getState().entries).toHaveLength(2)
    expect(screen.getByText('a')).toBeTruthy()
    expect(screen.getByText('b')).toBeTruthy()
  })

  it('hands the same text to the share sheet', async () => {
    // Two buttons, one report — what a user copies and what they share must
    // never differ, or a bug report depends on which button they pressed.
    logInfo('a')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByTestId('copy-report'))
    })
    await act(async () => {
      fireEvent.press(screen.getByTestId('share-report'))
    })

    // Everything but the `Written` line, which is the moment each report was
    // built and is *meant* to differ between two presses.
    const withoutTimestamp = (text: string) =>
      text
        .split('\n')
        .filter((line) => !line.startsWith('Written'))
        .join('\n')

    const copied = (Clipboard.setString as jest.Mock).mock.calls[0][0] as string
    const shared = (Share.share as jest.Mock).mock.calls[0][0].message as string
    expect(withoutTimestamp(shared)).toBe(withoutTimestamp(copied))
    // Guard against the comparison passing because both are empty.
    expect(withoutTimestamp(copied)).toContain('MiO problem report')
  })

  it('says so rather than claiming success when the clipboard refuses', async () => {
    // Core `Clipboard` is deprecated and could be removed under us; the share
    // button is still there, and the notice has to say that.
    ;(Clipboard.setString as jest.Mock).mockImplementationOnce(() => {
      throw new Error('gone')
    })
    logInfo('a')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByTestId('copy-report'))
    })

    await waitFor(() => expect(screen.getByText('Could not copy. Try Share instead.')).toBeTruthy())
  })

  it('does not report a failure when the user dismisses the share sheet', async () => {
    // Dismissing rejects on some Android versions, which is not a failure.
    ;(Share.share as jest.Mock).mockRejectedValueOnce(new Error('dismissed'))
    logInfo('a')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByTestId('share-report'))
    })

    expect(screen.queryByText('Could not copy. Try Share instead.')).toBeNull()
  })

  it('still empties on Clear, which is the one thing that should', async () => {
    // Keeping entries through an upload must not quietly disable the button
    // whose entire job is to throw them away.
    logInfo('a')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByText('Clear'))
    })

    expect(useDiagnostics.getState().entries).toHaveLength(0)
  })

  it('cannot be asked to report an empty log', async () => {
    await render(<DiagnosticsScreen />)

    await act(async () => {
      fireEvent.press(screen.getByTestId('copy-report'))
    })

    expect(Clipboard.setString).not.toHaveBeenCalled()
  })

  it('shows no report link while no destination is configured', async () => {
    /*
     * ⚠️ The empty `REPORT_FORM_URL` is a *state*, not a placeholder awaiting
     * tidy-up. A "report a problem" button that opens nothing is the same dead
     * UI #664 removed — so the absence has to be asserted, or someone shipping
     * the section before the form exists would look correct.
     */
    jest.replaceProperty(report, 'REPORT_FORM_URL', '')
    logInfo('a')

    await render(<DiagnosticsScreen />)

    expect(screen.queryByTestId('report-form-link')).toBeNull()
  })

  it('ships with a destination that is actually configured', async () => {
    // The empty state above is a supported *fallback*, not where this should
    // sit. Without this, deleting the URL by accident would make every test
    // pass — the absence test would still be green and the presence test
    // supplies its own value.
    expect(report.REPORT_FORM_URL).toMatch(/^https:\/\//)
  })

  it('opens the form when one is configured', async () => {
    jest.replaceProperty(report, 'REPORT_FORM_URL', 'https://forms.test/mio')
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    logInfo('a')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByTestId('report-form-link'))
    })

    expect(openURL).toHaveBeenCalledWith('https://forms.test/mio')
  })

  it('is where the self-hosting door lives now, so the move lost nothing', async () => {
    /*
     * ⭐ The half that matters. Removing the row from Settings is easy to assert
     * and easy to get wrong: a change that deleted it outright would satisfy
     * every assertion on that screen and quietly end self-hosting.
     *
     * `/setup` is still the only door to a custom address, so it has to be
     * reachable from somewhere — and this is the screen a self-hoster already
     * reads, and the one that already prints the address (#374).
     */
    await render(<DiagnosticsScreen />)

    expect(screen.getByText('Change server')).toBeTruthy()
  })

  it('clears the log locally on request', async () => {
    logInfo('a')

    await render(<DiagnosticsScreen />)
    await act(async () => {
      fireEvent.press(screen.getByText('Clear'))
    })

    expect(useDiagnostics.getState().entries).toHaveLength(0)
    expect(screen.getByText('Nothing logged yet.')).toBeTruthy()
  })
})
