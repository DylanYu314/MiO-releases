/** Mirrors the backend's Pydantic schemas in `backend/app/schemas.py`. */

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
  /** EBU R128 measurements from import; null until analysed, and for silent
   *  files. Playback falls back to no correction rather than guessing. */
  loudness_lufs?: number | null
  peak_dbfs?: number | null
}

export type SearchPlatform = 'youtube' | 'bilibili'

export interface SearchResult {
  url: string
  title: string
  uploader: string | null
  duration: number | null
}

export type JobStatus = 'queued' | 'downloading' | 'converting' | 'tagging' | 'done' | 'failed'

/** The states a job passes through on the way to `done`, in order. */
export const JOB_PROGRESS_STEPS: JobStatus[] = ['queued', 'downloading', 'converting', 'tagging']

/** True once a job has finished, successfully or not — matches the backend. */
export function isTerminal(status: JobStatus | undefined): boolean {
  return status === 'done' || status === 'failed'
}

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

export type SongSortField = 'added_at' | 'title' | 'artist' | 'duration'
export type SortOrder = 'asc' | 'desc'

export interface SongQuery {
  q?: string
  sort?: SongSortField
  order?: SortOrder
  limit?: number
  offset?: number
}

export interface SpotifyAccount {
  id: number
  spotify_user_id: string
  display_name: string | null
  created_at: string
}

export interface SpotifyStatus {
  /** False when the backend has no SPOTIFY_CLIENT_ID — rendered differently
   *  from "configured but nobody has connected yet". */
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

export type PlaylistImportStatus =
  'queued' | 'fetching' | 'matching' | 'review' | 'importing' | 'done' | 'failed'

/** True once an import has finished, successfully or not — matches the backend. */
export function isImportTerminal(status: PlaylistImportStatus | undefined): boolean {
  return status === 'done' || status === 'failed'
}

export interface PlaylistImport {
  id: number
  service: string
  account_id: number | null
  external_playlist_id: string
  name: string
  status: PlaylistImportStatus
  track_count: number | null
  matched_count: number
  import_total: number | null
  imported_count: number
  failed_count: number
  playlist_id: number | null
  error: string | null
  created_at: string
  updated_at: string
}

export type TrackMatchStatus =
  | 'pending'
  | 'auto_matched'
  | 'needs_review'
  | 'no_match'
  | 'accepted'
  | 'rejected'
  | 'imported'
  | 'failed'

export interface MatchCandidate {
  url: string
  title: string
  uploader: string | null
  duration: number | null
  /** Null for candidates that didn't come from matching (a YouTube-playlist
   *  entry is its own candidate — no score). */
  score: number | null
}

export interface TrackMatch {
  id: number
  position: number
  external_id: string | null
  title: string
  artist: string
  album: string | null
  duration_s: number | null
  candidates: MatchCandidate[]
  chosen_url: string | null
  confidence: number | null
  status: TrackMatchStatus
  import_job_id: number | null
  song_id: number | null
  error: string | null
}

/** A playlist without its contents — the list-view shape. */
export type PlaylistKind = 'user' | 'favourites'

export interface Playlist {
  id: number
  name: string
  kind: PlaylistKind
  item_count: number
  created_at: string
  updated_at: string
}

export interface PlaylistItem {
  id: number
  position: number
  song: Song
}

export interface PlaylistDetail {
  id: number
  name: string
  kind: PlaylistKind
  created_at: string
  updated_at: string
  items: PlaylistItem[]
}
