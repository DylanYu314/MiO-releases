import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

import { DEFAULT_SERVER_URL, normalizeServerUrl, useConnection } from '../src/api/connection'

describe('normalizeServerUrl', () => {
  it.each([
    ['192.168.1.10:8000', 'http://192.168.1.10:8000'],
    ['  192.168.1.10:8000  ', 'http://192.168.1.10:8000'],
    ['http://mio.local:8000/', 'http://mio.local:8000'],
    ['https://mio.example.com///', 'https://mio.example.com'],
    ['HTTPS://Mio.Example.com', 'HTTPS://Mio.Example.com'],
    ['', ''],
  ])('turns %p into %p', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected)
  })

  it('defaults to http, because a self-hosted address is often a LAN one with no certificate', () => {
    expect(normalizeServerUrl('mio.local:8000')).toBe('http://mio.local:8000')
  })
})

/**
 * The baked-in address (P10d).
 *
 * The behaviour that matters is not "there is a default" but what happens when
 * a stored value and a default disagree — which is every upgrade, for every
 * user who ever opened the advanced settings.
 */
describe('the shipped server address', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    await AsyncStorage.clear()
    useConnection.setState({
      serverUrl: null,
      accessKey: null,
      usingDefaultServer: true,
      loaded: false,
    })
  })

  it('is what the app uses when nothing has been stored', async () => {
    jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(null)

    await useConnection.getState().load()

    expect(useConnection.getState().serverUrl).toBe(DEFAULT_SERVER_URL)
    expect(useConnection.getState().usingDefaultServer).toBe(true)
  })

  it('loses to a stored address, so self-hosting survives an upgrade', async () => {
    await AsyncStorage.setItem('mio-server-url', 'http://192.168.1.10:8000')
    jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(null)

    await useConnection.getState().load()

    expect(useConnection.getState().serverUrl).toBe('http://192.168.1.10:8000')
    expect(useConnection.getState().usingDefaultServer).toBe(false)
  })

  it('is not pinned into storage when the user saves it unchanged', async () => {
    jest.spyOn(SecureStore, 'deleteItemAsync').mockResolvedValue()

    await useConnection.getState().save(DEFAULT_SERVER_URL, null)

    // Storing a copy would silently freeze this device on today's address: a
    // later build pointing somewhere new would be ignored by everyone who had
    // ever pressed save, and the symptom would be "the app stopped working"
    // with nothing in the UI to explain it.
    expect(await AsyncStorage.getItem('mio-server-url')).toBeNull()
    expect(useConnection.getState().usingDefaultServer).toBe(true)
  })

  it('is restored by clear(), rather than leaving the app with no server', async () => {
    jest.spyOn(SecureStore, 'deleteItemAsync').mockResolvedValue()
    await useConnection.getState().save('http://192.168.1.10:8000', null)

    await useConnection.getState().clear()

    expect(useConnection.getState().serverUrl).toBe(DEFAULT_SERVER_URL)
    expect(useConnection.getState().usingDefaultServer).toBe(true)
  })
})

describe('saveKey', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useConnection.setState({
      serverUrl: 'http://192.168.1.10:8000',
      accessKey: null,
      usingDefaultServer: false,
      loaded: true,
    })
  })

  it('stores the key without disturbing a custom server address', async () => {
    jest.spyOn(SecureStore, 'setItemAsync').mockResolvedValue()

    await useConnection.getState().saveKey('invited-key')

    expect(useConnection.getState().accessKey).toBe('invited-key')
    expect(useConnection.getState().serverUrl).toBe('http://192.168.1.10:8000')
    expect(useConnection.getState().usingDefaultServer).toBe(false)
  })

  it('deletes the stored key when given nothing, rather than writing an empty one', async () => {
    const remove = jest.spyOn(SecureStore, 'deleteItemAsync').mockResolvedValue()

    await useConnection.getState().saveKey(null)

    expect(remove).toHaveBeenCalledWith('mio_access_key')
    expect(useConnection.getState().accessKey).toBeNull()
  })
})
