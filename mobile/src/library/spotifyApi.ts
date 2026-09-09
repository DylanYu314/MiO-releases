import { describeError, logInfo, logWarn } from '../diagnostics/log'
import { ExternalSourceRefused } from './externalPlaylist'
import { SpotifyAuthError, accessToken, rememberProfile } from './spotifyAuth'

/**
 * The Spotify Web API, called from the device (#612).
 *
 * A port of `backend/app/spotify.py`'s read half. The token half is
 * `spotifyAuth.ts`; this is only "what does the account contain".
 *
 * ⚠️ **Two field names moved in Spotify's February 2026 migration**, and the
 * backend already accepts both — so this does too rather than picking the
 * newer one and quietly returning empty playlists for anyone the migration has
 * not reached:
 *
 * - a playlist's track summary: `tracks` → **`items`**
 * - a playlist entry's track object: `track` → **`item`**
 *
 * That is not a hypothetical: this repo's own notes record Spotify changing its
 * API twice mid-project, which is why the rule is to read the working client
 * rather than the documentation.
 */

const API_BASE = 'https://api.spotify.com/v1'
/** Spotify's own ceiling for these endpoints. */
const PAGE_LIMIT = 50
/** A playlist of ten thousand tracks is not a playlist; this stops a paging bug
 *  looping instead of failing. */
const MAX_PAGES = 100

/**
 * ⚠️ **Snake case, deliberately.** These are the field names the playlist
 * screen has always rendered, because they were the server's JSON. Keeping them
 * means the screen is untouched by #612 — a diff there would mean the *UI*
 * changed, when all that moved is where the data comes from.
 */
export interface SpotifyPlaylistSummary {
  id: string
  name: string
  image_url: string | null
  track_count: number
  owner_name: string | null
}

export interface SpotifyTrack {
  externalId: string | null
  title: string
  artist: string
  album: string | null
  durationSeconds: number | null
}

async function spotifyGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = await accessToken()
  if (!token) throw new SpotifyAuthError('Not signed in to Spotify')

  const query = new URLSearchParams(params).toString()
  const response = await fetch(`${API_BASE}${path}${query ? `?${query}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (response.status === 401) {
    // The token was refused rather than merely stale — `accessToken` already
    // refreshes anything close to expiry, so this means the grant is gone.
    throw new SpotifyAuthError('Spotify signed this device out')
  }
  if (!response.ok) {
    logWarn('spotify.requestFailed', `${path} ${response.status}`)
    throw new ExternalSourceRefused(`Spotify answered ${response.status}`, String(response.status))
  }
  return (await response.json()) as T
}

/** Who is signed in. Also what stores the display name for the screen. */
export async function fetchProfile(): Promise<{ id: string; displayName: string | null }> {
  const me = await spotifyGet<{ id: string; display_name?: string | null }>('/me')
  await rememberProfile(me.display_name ?? null, me.id)
  return { id: me.id, displayName: me.display_name ?? null }
}

interface RawPlaylist {
  id: string
  name?: string | null
  images?: { url?: string }[] | null
  /** February 2026 renamed this from `tracks`. */
  items?: { total?: number } | null
  tracks?: { total?: number } | null
  owner?: { display_name?: string | null } | null
}

/** One page of the user's own playlists, plus the overall total. */
export async function listPlaylists(
  offset = 0,
  limit = PAGE_LIMIT,
): Promise<{ items: SpotifyPlaylistSummary[]; total: number }> {
  const payload = await spotifyGet<{ items?: (RawPlaylist | null)[]; total?: number }>(
    '/me/playlists',
    { limit: String(limit), offset: String(offset) },
  )
  const items = (payload.items ?? []).filter((row): row is RawPlaylist => Boolean(row))
  return {
    items: items.map((row) => {
      const trackInfo = row.items ?? row.tracks ?? {}
      return {
        id: row.id,
        name: row.name || 'Untitled playlist',
        image_url: row.images?.[0]?.url ?? null,
        track_count: Number(trackInfo.total ?? 0),
        owner_name: row.owner?.display_name ?? null,
      }
    }),
    total: Number(payload.total ?? items.length),
  }
}

interface RawTrack {
  id?: string | null
  type?: string | null
  name?: string | null
  artists?: { name?: string }[] | null
  album?: { name?: string } | null
  duration_ms?: number | null
}

/**
 * One track object, or `null` for a gap.
 *
 * A playlist can hold a removed track or a podcast episode; both arrive as
 * entries and neither is something to import. ⚠️ **`type` may be absent** on
 * older payloads, which is why `undefined` counts as a track rather than being
 * refused — the backend makes the same allowance.
 */
export function parseTrack(raw: RawTrack | null | undefined): SpotifyTrack | null {
  if (!raw || !raw.name) return null
  if (raw.type != null && raw.type !== 'track') return null
  const artist = (raw.artists ?? [])
    .map((entry) => entry.name)
    .filter((name): name is string => Boolean(name))
    .join(', ')
  return {
    externalId: raw.id ?? null,
    title: raw.name,
    artist: artist || 'Unknown artist',
    album: raw.album?.name ?? null,
    durationSeconds: raw.duration_ms ? raw.duration_ms / 1000 : null,
  }
}

async function fetchAllPages(path: string, entryKey: 'item' | 'track'): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = []
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await spotifyGet<{
      items?: (Record<string, RawTrack | null> | null)[]
      next?: string | null
    }>(path, { limit: String(PAGE_LIMIT), offset: String(offset) })
    const entries = payload.items ?? []
    for (const entry of entries) {
      if (!entry) continue
      // February 2026 renamed a playlist entry's `track` to `item`; saved
      // tracks still use `track`. Accept both, in that order.
      const track = parseTrack(entry[entryKey] ?? entry.track)
      if (track) tracks.push(track)
    }
    offset += entries.length
    if (entries.length === 0 || payload.next == null) break
  }
  return tracks
}

export async function fetchPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  try {
    const tracks = await fetchAllPages(`/playlists/${playlistId}/items`, 'item')
    logInfo('spotify.playlistRead', `${tracks.length} track(s)`)
    return tracks
  } catch (error: unknown) {
    if (error instanceof SpotifyAuthError) throw error
    logWarn('spotify.playlistFailed', describeError(error))
    throw error
  }
}

/** The user's Liked Songs. */
export async function fetchSavedTracks(): Promise<SpotifyTrack[]> {
  return fetchAllPages('/me/tracks', 'track')
}
