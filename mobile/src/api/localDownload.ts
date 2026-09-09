import { useMutation, useQueryClient } from '@tanstack/react-query'

import { importToDevice } from '../library/deviceImport'
import { localLibraryKeys } from './localLibrary'
import { playlistKeys } from './localPlaylists'

/**
 * Fetching the audio for a song the library already knows about (#268).
 *
 * A playlist import records every accepted track before attempting any audio,
 * so a track it could not fetch leaves a row with no file — deliberately, so
 * the user can see what the import contained. This is how they get it
 * afterwards without going to find the link themselves.
 *
 * It is `importToDevice` on the song's own `source_url`, and that is not a
 * coincidence: `saveDeviceSongMetadata` keys on `source_url`, so the import
 * finds the existing row and downloads into it rather than making a second one.
 * The retry and the original import are the same operation.
 */
export function useDownloadSong() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (sourceUrl: string) => importToDevice(sourceUrl),
    // `onSettled`, not `onSuccess`: a failed attempt also changes the library.
    // `importToDevice` writes the row before downloading and removes it again
    // when the audio never arrives, so a failure leaves the cached list holding
    // a row that no longer exists — the same fault the import loop had.
    onSettled: async () => {
      // Both, because a song gaining its audio changes how it reads in the
      // library *and* in any playlist holding it.
      await queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
      await queryClient.invalidateQueries({ queryKey: playlistKeys.all })
    },
  })
}
