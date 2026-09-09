import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { create } from 'zustand'

/**
 * Where the backend is, and the key to talk to it.
 *
 * The two values are stored differently on purpose. The server URL is ordinary
 * configuration and lives in AsyncStorage. The access key is a **credential** —
 * it grants the right to search and import (ADR-009) — so it goes in SecureStore,
 * which is backed by the Android keystore rather than a plain file.
 *
 * It does **not** decide which library you see. P12 made the key do both jobs and
 * #170 split them: ownership belongs to the install id (`src/api/installId.ts`),
 * so a key can be added, changed or removed without a single song appearing or
 * disappearing.
 *
 * ## The address is baked in (P10d)
 *
 * Until the backend was hosted, the app had no choice but to ask: a laptop on
 * someone's LAN has no name a user could know. Now that it has one, asking is
 * indefensible — no music app opens by demanding a server address, and the
 * pilot tester is by definition someone who would not have one.
 *
 * So the shipped address comes from `extra.serverUrl` in `app.json`, baked in
 * at build time. A stored value still wins, which is what keeps self-hosting
 * possible; it is just no longer the first thing anyone sees.
 */

const URL_KEY = 'mio-server-url'
// SecureStore keys must be alphanumeric plus ._- (no spaces or slashes).
const ACCESS_KEY = 'mio_access_key'

/**
 * The server this build ships pointing at.
 *
 * Read through `expoConfig` rather than hardcoded here so one edit to
 * `app.json` re-points a build, and so a fork can point somewhere else without
 * touching source. Empty when unset — the app then behaves exactly as it did
 * before P10d and asks.
 */
export const DEFAULT_SERVER_URL: string =
  (Constants.expoConfig?.extra as { serverUrl?: string } | undefined)?.serverUrl ?? ''

export interface ConnectionState {
  serverUrl: string | null
  accessKey: string | null
  /** True when `serverUrl` is the built-in one rather than something the user
   *  typed. Lets the settings screen say which it is, and offer a way back. */
  usingDefaultServer: boolean
  /** False until stored values have been read back; the UI must not decide
   *  "not configured" from the empty initial state and bounce to setup. */
  loaded: boolean
  load: () => Promise<void>
  save: (serverUrl: string, accessKey: string | null) => Promise<void>
  /** Store a key without touching the server address — the invite-link path,
   *  where the address was never in question. */
  saveKey: (accessKey: string | null) => Promise<void>
  clear: () => Promise<void>
}

/** Trim a user-typed URL into something fetch() can use.
 *
 *  People type "192.168.1.10:8000" or paste a trailing slash; neither is a
 *  usable base. A missing scheme defaults to http, because the pilot server is
 *  reached over a LAN before it has a certificate.
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export const useConnection = create<ConnectionState>((set) => ({
  serverUrl: null,
  accessKey: null,
  usingDefaultServer: true,
  loaded: false,

  load: async () => {
    const [stored, accessKey] = await Promise.all([
      AsyncStorage.getItem(URL_KEY),
      SecureStore.getItemAsync(ACCESS_KEY),
    ])
    // A stored address wins, so anyone self-hosting keeps working across an
    // upgrade that introduces or changes the built-in one.
    const serverUrl = stored || DEFAULT_SERVER_URL || null
    set({ serverUrl, accessKey, usingDefaultServer: !stored, loaded: true })
  },

  save: async (serverUrl, accessKey) => {
    const normalized = normalizeServerUrl(serverUrl)
    // Saving the built-in address *removes* the override rather than pinning a
    // copy of it. Otherwise a later build pointing somewhere new would be
    // ignored by everyone who had once opened this screen and pressed save.
    if (normalized && normalized !== DEFAULT_SERVER_URL) {
      await AsyncStorage.setItem(URL_KEY, normalized)
    } else {
      await AsyncStorage.removeItem(URL_KEY)
    }
    if (accessKey) {
      await SecureStore.setItemAsync(ACCESS_KEY, accessKey)
    } else {
      await SecureStore.deleteItemAsync(ACCESS_KEY)
    }
    set({
      serverUrl: normalized || DEFAULT_SERVER_URL || null,
      accessKey: accessKey || null,
      usingDefaultServer: !normalized || normalized === DEFAULT_SERVER_URL,
      loaded: true,
    })
  },

  saveKey: async (accessKey) => {
    if (accessKey) {
      await SecureStore.setItemAsync(ACCESS_KEY, accessKey)
    } else {
      await SecureStore.deleteItemAsync(ACCESS_KEY)
    }
    set({ accessKey: accessKey || null, loaded: true })
  },

  clear: async () => {
    await AsyncStorage.removeItem(URL_KEY)
    await SecureStore.deleteItemAsync(ACCESS_KEY)
    // Back to the shipped address, not to nothing — "reset" should return the
    // app to how it arrives, which is working.
    set({
      serverUrl: DEFAULT_SERVER_URL || null,
      accessKey: null,
      usingDefaultServer: true,
      loaded: true,
    })
  },
}))
