import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { fetchProfile, listPlaylists, type SpotifyPlaylistSummary } from '../library/spotifyApi'
import { beginSignIn, signOut, storedTokens } from '../library/spotifyAuth'
import { spotifyConfigured } from '../library/spotifyConfig'

/**
 * Spotify, from the device (#612).
 *
 * Every hook keeps its name and shape; the `queryFn` moved from the backend's
 * proxy endpoints to Spotify's own API, with the token held in SecureStore
 * rather than in `spotify_accounts` on the droplet. `serverTracklist.ts` is
 * deleted with this change, so **no import path reaches a server any more**.
 *
 * ⚠️ **`accountId` is gone.** It identified a row in the server's table, and a
 * device holds exactly one signed-in account — so the hooks that took one now
 * take nothing, and `useDisconnectSpotify` disconnects *the* account.
 */

/** Spotify caps this endpoint at 50 a page; 20 is a phone screen's worth. */
const PLAYLISTS_PAGE_SIZE = 20

export const spotifyKeys = {
  all: ['spotify'] as const,
  status: () => [...spotifyKeys.all, 'status'] as const,
  playlists: () => [...spotifyKeys.all, 'playlists'] as const,
}

export interface SpotifyStatus {
  /** False when **this build** carries no client id (`spotifyConfig.ts`).
   *  Distinct from "configured, but nobody has signed in", which is one tap
   *  away — the same distinction ADR-005 drew, moved from server config to
   *  build config. */
  configured: boolean
  connected: boolean
  displayName: string | null
}

/**
 * Whether Spotify can be used, and who is signed in.
 *
 * Both answers are local now, so this cannot fail for network reasons — which
 * is what the old endpoint's "local-only, answers either way" note was
 * protecting, achieved by there being nothing to ask.
 */
export function useSpotifyStatus() {
  return useQuery({
    queryKey: spotifyKeys.status(),
    queryFn: async (): Promise<SpotifyStatus> => {
      const tokens = await storedTokens()
      return {
        configured: spotifyConfigured(),
        connected: tokens !== null,
        displayName: tokens?.displayName ?? null,
      }
    },
  })
}

/**
 * Where to send the browser to sign in.
 *
 * ⚠️ **Async now, and that is not incidental**: the URL carries a PKCE
 * challenge that has to be generated and its verifier stored *before* the
 * browser opens. The old version was a pure string built from the server URL
 * because the server held the verifier.
 *
 * Still a browser journey rather than a `fetch` — a request would follow the
 * redirect and hand back Spotify's HTML, having authorized nothing.
 */
export async function spotifyLoginUrl(): Promise<string> {
  return beginSignIn()
}

/**
 * The signed-in user's playlists.
 *
 * Paged rather than loaded whole: a Spotify library runs to hundreds, and each
 * page is a live call to Spotify — from the phone now, not through the droplet.
 */
export function useSpotifyPlaylists(enabled = true) {
  return useInfiniteQuery({
    queryKey: spotifyKeys.playlists(),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { items, total } = await listPlaylists(pageParam, PLAYLISTS_PAGE_SIZE)
      return { items, total, limit: PLAYLISTS_PAGE_SIZE, offset: pageParam }
    },
    getNextPageParam: (lastPage: {
      items: SpotifyPlaylistSummary[]
      total: number
      offset: number
    }) => {
      const loaded = lastPage.offset + lastPage.items.length
      return loaded < lastPage.total ? loaded : undefined
    },
    enabled,
  })
}

/** Fetch and store the display name once, after signing in. */
export function useSpotifyProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => fetchProfile(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spotifyKeys.status() }),
  })
}

/**
 * Forget the signed-in account.
 *
 * Works whatever state Spotify is in, on purpose (ADR-005): the point of being
 * able to disconnect is that something has gone wrong, and requiring a working
 * Spotify setup to undo one is a trap. It is a `SecureStore` delete, so nothing
 * can refuse it.
 *
 * This forgets the **account**, not the music: songs it imported are ordinary
 * library rows and stay.
 */
export function useDisconnectSpotify() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => signOut(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spotifyKeys.all }),
  })
}
