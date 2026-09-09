import { useMutation, useQueryClient } from '@tanstack/react-query'

import { removeLocalSong, removeLocalSongs, type RemovalReport } from '../library/songs'
import { localLibraryKeys } from './localLibrary'

/**
 * Removing a song from this device (#220).
 *
 * Delete used to mean `DELETE /songs/{id}` — the server dropped the row and the
 * file, and the phone found out by refetching. Since #216 the library *is* the
 * device, so a server delete would leave the song sitting on the phone,
 * playable, while the app insisted it was gone.
 *
 * So delete is local: the audio and the row, together. `removeLocalSong` takes
 * the file first, because a row with no file is a state the schema already
 * models while a file with no row is invisible and unreclaimable.
 *
 * ## What this deliberately does not do
 *
 * **It does not touch the server.** A song that came from a server import still
 * has its row and audio there, and deleting the local copy does not reach for
 * them. That is #221's job and it needs a decision first — under #246 the
 * server never holds device-fetched audio at all, so the question is only about
 * the songs that predate it.
 *
 * Meaning "delete" is honest about its scope: it removes the song from **this
 * device**, which is where the user's library now lives.
 */
export function useDeleteLocalSong() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (songId: string | number) => removeLocalSong(String(songId)),
    // The library reads the device, so nothing changes on screen until it is
    // told to look again — the same omission that made a successful import
    // look like a failure (#216).
    onSuccess: () => queryClient.invalidateQueries({ queryKey: localLibraryKeys.all }),
  })
}

/**
 * Removing several songs at once (#569).
 *
 * The screen used to loop `useDeleteLocalSong`, and every call invalidated the
 * library — so the list re-read SQLite and rebuilt itself between each song.
 * I could watch them go one at a time.
 *
 * One mutation, one invalidation. The batching that matters is in
 * `removeLocalSongs`; what this adds is doing the refresh **once**, which is
 * the half the user was actually seeing.
 */
export function useDeleteLocalSongs() {
  const queryClient = useQueryClient()

  return useMutation<RemovalReport, Error, readonly (string | number)[]>({
    mutationFn: (songIds) => removeLocalSongs(songIds.map(String)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: localLibraryKeys.all }),
  })
}
