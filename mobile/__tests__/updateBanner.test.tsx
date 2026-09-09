import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { Linking } from 'react-native'

import i18n from '../src/i18n'
import { UpdateBanner } from '../src/components/UpdateBanner'

const mockReloadAsync = jest.fn().mockResolvedValue(undefined)
const mockUseUpdates = jest.fn()

jest.mock('expo-updates', () => ({
  get useUpdates() {
    return mockUseUpdates
  },
  reloadAsync: (...args: unknown[]) => mockReloadAsync(...args),
  checkForUpdateAsync: jest.fn().mockResolvedValue({ isAvailable: false }),
  fetchUpdateAsync: jest.fn().mockResolvedValue(undefined),
}))

const mockFetchLatestVersion = jest.fn()
jest.mock('../src/updates/latestVersion', () => ({
  ...jest.requireActual('../src/updates/latestVersion'),
  fetchLatestVersion: (...args: unknown[]) => mockFetchLatestVersion(...args),
}))

jest.mock('expo-constants', () => ({ expoConfig: { version: '1.0.0' } }))

beforeEach(async () => {
  await i18n.changeLanguage('en')
  jest.clearAllMocks()
  mockUseUpdates.mockReturnValue({ downloadedUpdate: undefined })
  mockFetchLatestVersion.mockResolvedValue(null)
})

describe('UpdateBanner', () => {
  it('renders nothing when there is nothing to say', async () => {
    render(<UpdateBanner />)
    await waitFor(() => expect(mockFetchLatestVersion).toHaveBeenCalled())
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })

  it('offers a restart when a JS bundle is downloaded', async () => {
    mockUseUpdates.mockReturnValue({ downloadedUpdate: { updateId: 'abc' } })
    render(<UpdateBanner />)

    await waitFor(() => expect(screen.getByTestId('update-banner')).toBeTruthy())
    expect(screen.getByText('Update ready')).toBeTruthy()

    fireEvent.press(screen.getByText('Restart now'))
    await waitFor(() => expect(mockReloadAsync).toHaveBeenCalled())
  })

  it('points at the download when a newer APK exists', async () => {
    mockFetchLatestVersion.mockResolvedValue({
      versionName: '1.1.0',
      url: 'https://mio.dlany.uk/MiO-v1.1.0.apk',
    })
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    render(<UpdateBanner />)

    await waitFor(() => expect(screen.getByText('New version available')).toBeTruthy())
    fireEvent.press(screen.getByText('Get it'))

    expect(openURL).toHaveBeenCalledWith('https://mio.dlany.uk/MiO-v1.1.0.apk')
    // It also goes away, rather than sitting over the app the user just left.
    await waitFor(() => expect(screen.queryByTestId('update-banner')).toBeNull())
  })

  it('stays quiet when the manifest names the version already running', async () => {
    mockFetchLatestVersion.mockResolvedValue({
      versionName: '1.0.0',
      url: 'https://mio.dlany.uk/MiO.apk',
    })
    render(<UpdateBanner />)

    await waitFor(() => expect(mockFetchLatestVersion).toHaveBeenCalled())
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })

  it('prefers the APK message when both are true, because a restart cannot fix native code', async () => {
    mockUseUpdates.mockReturnValue({ downloadedUpdate: { updateId: 'abc' } })
    mockFetchLatestVersion.mockResolvedValue({
      versionName: '2.0.0',
      url: 'https://mio.dlany.uk/MiO-v2.0.0.apk',
    })
    render(<UpdateBanner />)

    await waitFor(() => expect(screen.getByText('New version available')).toBeTruthy())
    expect(screen.queryByText('Update ready')).toBeNull()
  })

  it('can be dismissed for this launch', async () => {
    mockUseUpdates.mockReturnValue({ downloadedUpdate: { updateId: 'abc' } })
    render(<UpdateBanner />)

    await waitFor(() => expect(screen.getByTestId('update-banner')).toBeTruthy())
    fireEvent.press(screen.getByText('Not now'))
    await waitFor(() => expect(screen.queryByTestId('update-banner')).toBeNull())
  })

  it('says nothing at all when the manifest cannot be read', async () => {
    // The offline case, and the one that must never become an error message
    // (#613: MiO ships with no server).
    mockFetchLatestVersion.mockResolvedValue(null)
    render(<UpdateBanner />)

    await waitFor(() => expect(mockFetchLatestVersion).toHaveBeenCalled())
    expect(screen.queryByTestId('update-banner')).toBeNull()
  })
})
