import type { AudioMetadata, AudioSource } from 'expo-audio'

import { getInstallId } from '../api/installId'
import type { PlayableSong } from '../api/types'

/** `AudioSource` also admits a bare string or a bundled asset id. We only ever
 *  build the remote-object form, and saying so keeps `headers` reachable for
 *  callers and tests. */
type RemoteAudioSource = Extract<AudioSource, { uri?: string }>

/**
 * Turning a `Song` into something `expo-audio` can play, and into the metadata
 * Android shows on the lock screen.
 *
 * Kept pure and in its own file so it can be tested without the native module.
 */

/**
 * Where to play this song from — the device if we have it, the server if not.
 *
 * ## The local file wins, and that is the whole point of #159
 *
 * A `file://` URI needs no server, no network and no headers. Once the audio is
 * on the device the song is playable on a train, in a lift, and after the
 * server has gone away — which is the claim local-first exists to make and the
 * one no amount of streaming can.
 *
 * It is also the *faster* path, and the one that cannot 404: a stream depends
 * on the row still existing, still being owned by this install, and the network
 * being there.
 *
 * ## The server URL, with the headers that make it ours
 *
 * Still the fallback, because a row can exist before its bytes do — a song
 * imported on another device, or one whose download has not finished.
 *
 * `expo-audio` forwards `headers` on remote sources, so the same identification
 * the API client sends reaches the audio endpoint too. The one that matters is
 * **`X-Install-Id`**: since #170 ownership belongs to the install, and without it
 * the stream 404s even though the row exists. The access key rides along for
 * consistency with every other request, but this endpoint does not check it —
 * playback is not gated (ADR-009 gates search and import).
 */
export function audioSourceFor(
  song: PlayableSong,
  serverUrl: string | null,
  accessKey: string | null,
  fileUri?: string | null,
): RemoteAudioSource | null {
  // No headers and no server: the file is simply there. Checked before
  // `serverUrl`, so a device with no server configured still plays its library.
  if (fileUri) return { uri: fileUri }

  if (!serverUrl) return null
  const headers: Record<string, string> = {}
  if (accessKey) headers['X-Unlock-Key'] = accessKey
  const installId = getInstallId()
  if (installId) headers['X-Install-Id'] = installId

  return {
    uri: `${serverUrl}/songs/${song.id}/audio`,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  }
}

/**
 * Cover art for the lock screen — the device's copy, or nothing (#218).
 *
 * This returned `undefined` unconditionally until covers came to the device, and
 * the reason is the same one that moved the audio: **`artworkUrl` is a bare
 * string handed to the OS**, which fetches it itself, so none of our headers ride
 * along. That worked before #170, when the library was unowned and needed no
 * identification; once every row belonged to an install, an unauthenticated fetch
 * of `/cover` always 404'd and Android drew a blank tile.
 *
 * A `file://` URI needs headers from nobody, so there is nothing left to
 * authenticate. That also retires the "short-lived signed media URL" idea this
 * comment used to propose — a token in the query string would have worked, and
 * would have been a server-side answer to a problem local-first dissolves.
 *
 * Still `undefined` for a song whose cover is absent, which is an ordinary state:
 * plenty of sources have no artwork, and a blank tile is the honest result.
 */
export function artworkUrlFor(coverUri?: string | null): string | undefined {
  return coverUri ?? undefined
}

/** What Android draws on the lock screen and in the notification shade. */
export function lockScreenMetadata(song: PlayableSong, artworkUrl?: string): AudioMetadata {
  return {
    title: song.title,
    artist: song.artist,
    albumTitle: song.album ?? undefined,
    artworkUrl,
  }
}
