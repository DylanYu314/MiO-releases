import { useCallback } from 'react'

import { useLocalFavouriteIds, useSetLocalFavourite } from '../api/localPlaylists'
import { usePlaybackStatus } from '../player/playbackStatus'
import { usePlayer } from '../player/store'
import { NowPlayingBar } from './NowPlayingBar'
import { useGuardedRouter } from '../navigation/useGuardedRouter'

/**
 * The mini player's other half (#226).
 *
 * `PlayerHost` owns the audio and must never unmount, so it lives outside the
 * navigator. This owns the bar, and must be positioned by the tab navigator so
 * it sits directly above the tab bar — so it lives inside, rendered as part of
 * the tab bar itself.
 *
 * That placement is what makes it survive a tab change: swapping tabs re-renders
 * the screen, not the bar. It does unmount when a root-level route covers the
 * tabs, which today means the queue and setup screens — the queue *is* the
 * player screen, and setup is the "there is no server yet" state, so neither
 * wants a mini player. The audio keeps playing through both regardless, which is
 * the part that matters.
 *
 * Purely a container: `NowPlayingBar` stays presentational and prop-driven, so
 * it can still be rendered in a test without a player or a navigator.
 */
export function MiniPlayer() {
  const router = useGuardedRouter()
  const song = usePlayer((state) => state.current?.song ?? null)
  const isPlaying = usePlayer((state) => state.isPlaying)

  // Selected field by field: these tick about twice a second, and subscribing
  // to the whole object would re-render on every tick even when paused.
  const position = usePlaybackStatus((state) => state.position)
  const duration = usePlaybackStatus((state) => state.duration)
  const isBuffering = usePlaybackStatus((state) => state.isBuffering)
  const error = usePlaybackStatus((state) => state.error)

  const { data: favouriteIds } = useLocalFavouriteIds()
  const toggleFavourite = useSetLocalFavourite()
  const songId = song ? String(song.id) : null
  const onToggleFavourite = useCallback(
    (favourite: boolean) => {
      if (songId) toggleFavourite.mutate({ songId, favourite })
    },
    [songId, toggleFavourite],
  )

  if (!song) return null

  return (
    <NowPlayingBar
      song={song}
      isPlaying={isPlaying}
      position={position}
      duration={duration}
      isBuffering={isBuffering}
      error={error}
      onToggle={() => usePlayer.getState().togglePlay()}
      // The banner is a summary now (#230); skipping and the queue both live on
      // the panel this opens.
      onOpen={() => router.push('/playing')}
      isFavourite={favouriteIds ? favouriteIds.has(String(song.id)) : undefined}
      onToggleFavourite={onToggleFavourite}
    />
  )
}
