/**
 * Hand-mirrored from the backend's Pydantic schemas, as the web client does.
 * ADR-003 records the drift risk this accepts: there is no generated client, so
 * a backend change lands here by hand or not at all.
 */

export interface AccessStatus {
  /** Whether the import gate is enforcing on this server at all. */
  locked: boolean
  /** Whether *this* client's key gets through it. */
  unlocked: boolean
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export interface Song {
  id: number
  title: string
  artist: string
  album: string | null
  duration: number | null
  source_url: string
  source_platform: string
  added_at: string
  loudness_lufs: number | null
  peak_dbfs: number | null
}

/**
 * A song as anything that plays or lists it needs to see (#216).
 *
 * `Song` is the API shape and keeps its numeric server id. This is the wider
 * one the UI works in, because the library now reads the **device** and a song
 * fetched by the device has no server row at all — its id is the local string
 * one, and `server_song_id` is null.
 *
 * Widening rather than replacing, so an API `Song` is still assignable and the
 * screens that genuinely deal in server rows (playlists, favourites) do not
 * have to change yet. Those move in #219.
 */
export interface PlayableSong extends Omit<Song, 'id'> {
  id: string | number
  server_song_id?: number | null
  /** Where the audio is on this device, when it is here. */
  file_uri?: string | null
  /**
   * Where the cover art is on this device, when there is any (#218).
   *
   * Optional and nullable for two different reasons, and both are ordinary:
   * a song may simply have no artwork, and a `PlayableSong` reconstructed from
   * a persisted queue predates the column. Neither is a failure — the row draws
   * a placeholder and moves on.
   */
  cover_uri?: string | null
}

/**
 * Whether this song can actually be played (#268).
 *
 * `file_uri` null means *known about, not downloaded* — a real state since
 * #159, and the one a failed track in a playlist import leaves behind. Whether
 * that is playable depends on where the song came from:
 *
 * - **from a server import** (`server_song_id` set), the server still has a
 *   copy, so it streams and nothing is wrong;
 * - **fetched by this device**, there is no copy anywhere, so playing it would
 *   be silence — which reads as a broken app rather than a missing download.
 *
 * The second is what a playlist import now creates on purpose: the metadata is
 * kept so the user can see what the import contained (#268).
 */
export function isPlayable(song: PlayableSong): boolean {
  return song.file_uri != null || song.server_song_id != null
}

/**
 * A playlist without its contents, as `GET /playlists` returns it.
 *
 * `kind` distinguishes an ordinary playlist from the single `favourites` one
 * the backend maintains. The list endpoint does not filter by it, so a client
 * that wants only user playlists has to say so — favourites gets its own screen
 * in P7 (#134) rather than appearing as a normal row.
 */
/*
 * `Playlist` — the shape of a `GET /playlists` row — was here and is gone
 * (#324). Its only readers were the server playlist hooks this sweep deleted;
 * the playlist list is read from this device now. `PlaylistDetail` below stays,
 * because `handover.ts` still fetches one when importing a server playlist onto
 * the phone.
 */

export interface PlaylistItem {
  id: number
  position: number
  song: Song
}

/** `GET /playlists/{id}` — the playlist with its songs, in order. */
export interface PlaylistDetail {
  id: number
  name: string
  kind: string
  created_at: string
  updated_at: string
  items: PlaylistItem[]
}

/** The states an import job passes through, in order, on the way to `done`. */
export type JobStatus = 'queued' | 'downloading' | 'converting' | 'tagging' | 'done' | 'failed'

export const JOB_PROGRESS_STEPS: JobStatus[] = ['queued', 'downloading', 'converting', 'tagging']

/** True once a job has finished, successfully or not — matches the backend. */
export function isTerminal(status: JobStatus | null | undefined): boolean {
  return status === 'done' || status === 'failed'
}

/**
 * Failure codes worth trying again on their own (#222).
 *
 * A deliberately short list. Retrying is only kind when the same request could
 * plausibly succeed a moment later — a rate limit lifts, a timeout was one bad
 * connection, a bot check is famously per-request. Everything else is a fact
 * about the video: `private`, `removed`, `age_restricted` and `geo_restricted`
 * will fail identically forever, and retrying them wastes the user's time while
 * telling them nothing.
 *
 * `took_too_long` (#213) is excluded on purpose even though it looks transient:
 * the backend already spent its ceiling on that attempt, and doing it again
 * costs another three minutes to reach the same place.
 *
 * `unknown` is included. It means the message matched no rule, which is more
 * often a new phrasing of something temporary than a new permanent state — and
 * the retry budget bounds the cost of being wrong.
 */
const RETRYABLE_FAILURES = new Set(['bot_check', 'rate_limited', 'network', 'unknown'])

export function isRetryable(errorCode: string | null | undefined): boolean {
  return errorCode != null && RETRYABLE_FAILURES.has(errorCode)
}

/** `POST /jobs` and `GET /jobs/{id}` — one link being turned into a song. */
export interface Job {
  id: number
  source_url: string
  status: JobStatus
  progress: number | null
  song_id: number | null
  error: string | null
  /** Why it failed, as a code the backend derives from `error` (#177). Clients
   *  translate it; `error` keeps the raw yt-dlp text for the detail view. */
  error_code: string | null
  created_at: string
  updated_at: string
}

/** Sources `GET /search` can search. Bilibili is rate-limited from outside
 *  China and refuses roughly half of spaced requests (enhancement-track-2). */
export type SearchPlatform = 'youtube' | 'bilibili'

export interface SearchResult {
  url: string
  title: string
  uploader: string | null
  duration: number | null
  /** Cover art for the result, where the source offered one (#312). Optional
   *  because a row without art is an ordinary state, not a failure. */
  thumbnail?: string | null
}

/** The states a playlist import passes through. YouTube imports skip `matching`
 *  entirely — a YouTube entry is already its own candidate (ADR-010). */
export type ImportStatus =
  'queued' | 'fetching' | 'matching' | 'review' | 'importing' | 'done' | 'failed'

/** True once an import has finished, successfully or not. */
export function isImportTerminal(status: ImportStatus | undefined): boolean {
  return status === 'done' || status === 'failed'
}

/**
 * What the matcher decided about one track, and what the human decided after.
 *
 * `pending` → the matcher has not reached it. `auto_matched` cleared the
 * confident threshold, `needs_review` did not, `no_match` found nothing at all.
 * `accepted` and `rejected` are the human's answer; `imported` and `failed` are
 * what happened afterwards.
 */
export type TrackMatchStatus =
  | 'pending'
  | 'auto_matched'
  | 'needs_review'
  | 'no_match'
  | 'accepted'
  | 'rejected'
  | 'imported'
  | 'failed'

/** One thing the matcher found on YouTube for a track. */
export interface MatchCandidate {
  url: string
  title: string
  uploader: string | null
  duration: number | null
  /** A picture of what would be downloaded (#312). Optional, because
   *  candidates stored before it exists carry no such key — and public, so it
   *  is fetched directly with none of our headers. */
  thumbnail?: string | null
  /** Null for a candidate that did not come from matching — a YouTube-playlist
   *  entry is its own candidate and carries no machine score (ADR-010). */
  score: number | null
}

/**
 * One track in a reviewed import, as `GET /playlist-imports/{id}/matches`
 * returns it.
 *
 * This used to carry only the fields the device needed to *fetch* a track,
 * because the app could confirm an import but not review one. #203 added the
 * review, which needs the rest: the candidates to choose between, and the
 * confidence to explain why a row is being asked about at all.
 */
export interface TrackMatch {
  id: number
  position: number
  external_id: string | null
  title: string
  artist: string
  album: string | null
  duration_s: number | null
  candidates: MatchCandidate[]
  /** What the user accepted. `null` means nothing was chosen. */
  chosen_url: string | null
  /** **Machine** confidence, 0–1. `null` for a hand-pasted URL rather than a
   *  stale number from the candidate it replaced. */
  confidence: number | null
  status: TrackMatchStatus
  song_id: number | null
  error: string | null
}

export interface SpotifyAccount {
  id: number
  spotify_user_id: string
  display_name: string | null
  created_at: string
}

export interface SpotifyStatus {
  /** False when the backend has no `SPOTIFY_CLIENT_ID`. Rendered differently
   *  from "configured, but nobody has connected an account yet" — one is the
   *  server not being set up, the other is a thing the user can fix. */
  configured: boolean
  accounts: SpotifyAccount[]
}

export interface SpotifyPlaylist {
  id: string
  name: string
  image_url: string | null
  track_count: number
  owner_name: string | null
}

/** The Spotify playlist id sentinel for the user's Liked Songs. */
export const LIKED_SONGS_ID = 'liked'

/**
 * `GET /google/status` — three states, not two (#106).
 *
 * `configured: false` is the server having no Google credentials, which nothing
 * in the app can fix; configured with no `channel_title` is nobody having
 * connected, which is one tap away. The same distinction `SpotifyStatus` makes,
 * and for the same reason: collapsing them offers a button that can only 503.
 */
export interface GoogleStatus {
  configured: boolean
  channel_id: string | null
  channel_title: string | null
  connected_at: string | null
}

export interface GooglePlaylist {
  id: string
  title: string
  track_count: number
  /** `"private"`, `"public"` or `"unlisted"`. Shown, because private playlists
   *  are the entire reason this feature exists. */
  privacy: string | null
}

/**
 * One video for this device to fetch itself (#106).
 *
 * A video id and a title, and deliberately nothing else — there is no matching
 * step here, because a private playlist hands back exact videos. The phone
 * turns each of these into the same download a pasted link performs (#246).
 */
export interface GoogleTrack {
  video_id: string
  title: string
  channel_title: string | null
}

/** `GET /playlist-imports/{id}` — one attempt at importing an external playlist. */
export interface PlaylistImport {
  id: number
  service: string
  account_id: number | null
  external_playlist_id: string
  name: string
  status: ImportStatus
  track_count: number | null
  matched_count: number
  import_total: number | null
  imported_count: number
  failed_count: number
  playlist_id: number | null
  error: string | null
  /** Whether *this device* owes the server candidates for each track (#353).
   *  True for an import the phone started; false for one the web client did,
   *  which the server matches itself. */
  client_matches: boolean
  created_at: string
  updated_at: string
}
