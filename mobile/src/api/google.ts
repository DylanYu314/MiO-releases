import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError, NetworkError, apiFetch } from './client'
import type { GooglePlaylist, GoogleStatus, GoogleTrack } from './types'

/**
 * The connected Google account, for private YouTube playlist import (#106).
 *
 * Shaped after `spotify.ts`, because the *connection* half really is the same
 * problem: an OAuth round trip through the system browser, a server-side
 * account row, and a status endpoint that answers whether any of it happened.
 *
 * **What is not the same is everything after it.** A Spotify import needs
 * matching, review and confirmation, because a Spotify track is not a YouTube
 * video. A private YouTube playlist hands back exact video ids, so there is
 * nothing to match and nothing to confirm — the phone simply downloads each one
 * the way a pasted link already does (#246). 2026-08-12: *"its from
 * youtube, user know what they importing."*
 */

export const googleKeys = {
  all: ['google'] as const,
  status: () => [...googleKeys.all, 'status'] as const,
  playlists: () => [...googleKeys.all, 'playlists'] as const,
}

/**
 * Why a Google call failed, in a word the screen can act on.
 *
 * **The three the issue asks to be told apart**, plus the ones that share their
 * status codes:
 *
 * - `reauth` — the connection has expired. Happens about **every 7 days**
 *   while the consent screen is in Testing, so it is the common case, not an
 *   edge one. The answer is to connect again.
 * - `quota` — the project's daily Data API allowance is spent. The one failure
 *   that waiting actually fixes; it resets at midnight Pacific.
 * - `unconfigured` — the server has no Google credentials. Nothing in the app
 *   can fix it.
 * - `locked` — the **access key** gate (ADR-009), which answers the same 401 as
 *   `reauth` and asks for the opposite thing. Telling these apart is what
 *   `ApiError.code` is for; without it the weekly expiry would read as "your
 *   key is wrong".
 * - `notConnected` — no account at all, e.g. disconnected in another tab.
 * - `offline` — the request never reached the server.
 *
 * `null` for anything unrecognised, so the caller shows the server's own
 * message rather than inventing a category for it.
 */
export type GoogleFailure =
  'reauth' | 'quota' | 'unconfigured' | 'locked' | 'notConnected' | 'offline'

/** The code the backend puts on a 401 it wants read as "reconnect". */
export const GOOGLE_REAUTH = 'google_reauth'

export function googleFailure(error: unknown): GoogleFailure | null {
  if (error instanceof NetworkError) return 'offline'
  if (!(error instanceof ApiError)) return null
  // The code first, because the status alone cannot separate these two.
  if (error.status === 401) return error.code === GOOGLE_REAUTH ? 'reauth' : 'locked'
  if (error.status === 429) return 'quota'
  if (error.status === 503) return 'unconfigured'
  if (error.status === 404) return 'notConnected'
  return null
}

/**
 * The connected channel's own playlists, private ones included.
 *
 * Unpaged, because the server does not page it either: `list_playlists` follows
 * every page itself, one quota unit per fifty, and a person has tens of
 * playlists rather than thousands.
 *
 * **Not retried for a 4xx.** Every failure this query has below 500 is an
 * *answer* — expired, locked, spent, unconfigured — and asking three more times
 * changes none of them, while spending quota on the one that is about quota.
 */
export function useGooglePlaylists(enabled = true) {
  return useQuery({
    queryKey: googleKeys.playlists(),
    queryFn: () => apiFetch<GooglePlaylist[]>('/google/playlists'),
    enabled,
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status < 500) && failureCount < 2,
  })
}

/**
 * Every video in one playlist, for this device to fetch itself.
 *
 * A plain function rather than a hook: the caller is the import run, which
 * outlives the screen that started it (ADR-019) and must not be re-fetched by a
 * component re-rendering. It is one call at the top of a run.
 *
 * This is the entire handover. The response is video ids; the phone downloads
 * each one exactly as a pasted link does (#246), and the server never sees a
 * byte of audio.
 */
export function fetchGooglePlaylistItems(playlistId: string): Promise<GoogleTrack[]> {
  return apiFetch<GoogleTrack[]>(`/google/playlists/${encodeURIComponent(playlistId)}/items`)
}

/**
 * Whether Google is set up, and whose channel is connected.
 *
 * **Three answers, and the screen renders each differently.** `configured:
 * false` is the server having no `GOOGLE_CLIENT_ID`, which no amount of tapping
 * will fix; configured with `channel_title: null` is nobody having connected,
 * which is one tap away; a channel title is ready to go. This endpoint is
 * ungated and answers even when the credentials are missing, which is what
 * makes the distinction visible at all.
 *
 * ⚠️ **A healthy answer here does not mean the connection works.** The stored
 * refresh token expires every 7 days while the consent screen is in Testing,
 * and this endpoint reads the database rather than Google — so it goes on
 * saying "connected as …" after the account has stopped working. Only a call
 * that actually reaches Google can find that out, which is why the listing
 * endpoints answer 401 with a code and why {@link isReauthRequired} exists.
 */
export function useGoogleStatus() {
  return useQuery({
    queryKey: googleKeys.status(),
    queryFn: () => apiFetch<GoogleStatus>('/google/status'),
  })
}

/**
 * Where to send the browser to connect the account.
 *
 * **Not `apiFetch`**, for the same reason `spotifyLoginUrl` is not: the backend
 * answers with a 302 to Google's consent page, and `fetch` would follow it and
 * hand back Google's HTML having authorized nothing. This is a browser journey.
 *
 * `client=app` is what makes the callback come back to `mio://add/import`
 * rather than the web client. It is an enum the server resolves; there is
 * deliberately no way to pass a URL, which would be an open redirect carrying
 * an OAuth code.
 */
export function googleLoginUrl(serverUrl: string): string {
  return `${serverUrl}/google/login?client=app`
}

/**
 * Forget the connected account.
 *
 * Ungated and unconfigured-safe on the server, on purpose: the whole reason to
 * disconnect is that something has gone wrong, and requiring a working Google
 * setup to undo a Google setup is a trap (the argument ADR-005 makes for
 * Spotify).
 *
 * Local tokens only — the grant at Google's end is the user's to revoke from
 * their own account page. Doing it here would make "disconnect from MiO"
 * quietly mean "sign MiO out of everything for ever".
 */
export function useDisconnectGoogle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiFetch<void>('/google/account', { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: googleKeys.all }),
  })
}
