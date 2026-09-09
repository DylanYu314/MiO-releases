import { normalizationGain } from '@mio/shared/loudness'
import { useCallback, useEffect, useRef, useState } from 'react'

import { songAudioUrl, songCoverUrl } from '../api/songs'
import type { Song } from '../api/types'
import {
  applyAudioProcessing,
  getAudioGraph,
  scheduleEqualPowerFade,
  type AudioGraph,
} from './audioGraph'
import { useAudioSettingsStore } from './audioSettings'
import { selectCurrentSong, selectHasNext, usePlayerStore } from './store'

/** How often the resume position is written, in seconds of playback. */
const RESUME_WRITE_SECONDS = 5

interface AudioBinding {
  audioRef: React.RefObject<HTMLAudioElement | null>
  currentTime: number
  duration: number
  seek: (seconds: number) => void
}

type DeckId = 'a' | 'b'

/**
 * Drives playback from the player store.
 *
 * The store holds *intent* (which song, playing or paused, how loud); the
 * elements hold the actual playback. Keeping them out of the store means the
 * store stays pure and testable.
 *
 * There are two decks (ADR-012). Only one is *active* at a time — it is the one
 * the store's current song plays on, the one that reports position, and the one
 * seek and play/pause act upon. A crossfade (G2) starts the next track on the
 * idle deck, ramps the two fade gains past each other, and swaps which is
 * active. With crossfade off, or with no Web Audio at all, deck A is active
 * forever and this behaves exactly as the single-element version did.
 */
export function useAudioElement(): AudioBinding {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const graphRef = useRef<AudioGraph | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  /**
   * When the resume position was last written, and which load has already had
   * one applied (#183).
   *
   * `timeupdate` fires about four times a second, and persisting on each one
   * would write to localStorage several hundred times a song for a value nobody
   * reads until the next launch. Every few seconds is enough to come back to
   * roughly where you were, which is the whole promise.
   */
  const lastResumeWrite = useRef(0)
  const appliedResumeFor = useRef<number | null>(null)
  const [duration, setDuration] = useState(0)

  // Which deck is playing the store's current song. A ref, not state: the
  // crossfade sets it from inside an effect, and making it a dependency of the
  // effects that read it would re-run them mid-fade.
  const activeDeck = useRef<DeckId>('a')
  // The song id each deck currently has loaded, so a preloaded deck is not
  // reloaded (which would restart it) when the store catches up.
  const loadedSong = useRef<Record<DeckId, number | null>>({ a: null, b: null })
  // Guards the "nearly over, start the crossfade" check so it fires once per
  // track rather than on every timeupdate.
  const crossfadeStarted = useRef(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /** Mirrors the normalization toggle so the per-deck helper can read it
   *  without becoming dependent on it. */
  const normalizeEnabled = useRef(true)

  const currentSong = usePlayerStore(selectCurrentSong)
  const isPlaying = usePlayerStore((state) => state.isPlaying)
  const volume = usePlayerStore((state) => state.volume)
  const muted = usePlayerStore((state) => state.muted)
  const playbackRate = usePlayerStore((state) => state.playbackRate)
  const sleepAt = usePlayerStore((state) => state.sleepAt)
  const restartNonce = usePlayerStore((state) => state.restartNonce)
  const trackEnded = usePlayerStore((state) => state.trackEnded)
  const setResume = usePlayerStore((state) => state.setResume)
  const setPlaying = usePlayerStore((state) => state.setPlaying)

  const eqGains = useAudioSettingsStore((state) => state.eqGains)
  const channelMode = useAudioSettingsStore((state) => state.channelMode)
  const balance = useAudioSettingsStore((state) => state.balance)
  const normalizeLoudness = useAudioSettingsStore((state) => state.normalizeLoudness)

  /** Every deck that exists — one without Web Audio, two with it. */
  const decks = useCallback((): Record<DeckId, HTMLAudioElement | null> => {
    const graph = graphRef.current
    if (graph) return { a: graph.deckA, b: graph.deckB }
    return { a: audioRef.current, b: null }
  }, [])

  const deckElement = useCallback((deck: DeckId) => decks()[deck], [decks])

  const activeElement = useCallback(() => deckElement(activeDeck.current), [deckElement])

  /** Set a deck's normalization gain for the song it is about to play. The
   *  gain follows the *song*, not the deck, so it has to be set wherever a
   *  song is placed — including the idle deck during a crossfade, or the
   *  incoming track would arrive at the outgoing track's level. */
  const normalizeDeck = useCallback((deck: DeckId, song: Song | null) => {
    const graph = graphRef.current
    if (!graph || !song) return
    const gain = normalizationGain(song.loudness_lufs, song.peak_dbfs, normalizeEnabled.current)
    const node = deck === 'a' ? graph.normGainA : graph.normGainB
    node.gain.value = gain
  }, [])

  const fadeGainFor = useCallback((deck: DeckId) => {
    const graph = graphRef.current
    if (!graph) return null
    return deck === 'a' ? graph.fadeGainA : graph.fadeGainB
  }, [])

  /** Point a deck at a song, skipping the reload if it is already there. */
  const loadInto = useCallback(
    (deck: DeckId, songId: number) => {
      const element = deck === 'a' ? decks().a : decks().b
      if (!element) return
      if (loadedSong.current[deck] === songId) return
      element.src = songAudioUrl(songId)
      element.load()
      loadedSong.current[deck] = songId
    },
    [decks],
  )

  // Route the elements through the Web Audio graph (ADR-012). Built once, on
  // mount: the binding is permanent, so there is nothing to tear down and
  // nothing to rebuild. A null graph means Web Audio is unavailable and
  // playback runs straight off the one element, exactly as it did before G1.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    graphRef.current = getAudioGraph(audio)
  }, [])

  // EQ, channel mode and balance (G3). Declared after the graph-building effect
  // so the graph exists by the time this first runs; at neutral settings the
  // whole chain measures bit-identical to not being there.
  useEffect(() => {
    const graph = graphRef.current
    if (!graph) return
    applyAudioProcessing(graph, { eqGains, channelMode, balance })
  }, [eqGains, channelMode, balance])

  // Loudness normalization. Toggling it has to re-apply to the deck playing
  // right now, not just to whatever plays next.
  useEffect(() => {
    normalizeEnabled.current = normalizeLoudness
    normalizeDeck(activeDeck.current, currentSong)
  }, [normalizeLoudness, currentSong, normalizeDeck])

  // The current song arrives on a deck — either by crossfading onto the idle
  // one, or by loading straight onto the active one.
  useEffect(() => {
    if (!currentSong) return
    const graph = graphRef.current
    const outgoing = activeElement()
    if (!outgoing) return

    const { crossfadeSeconds, repeat, isPlaying: playing } = usePlayerStore.getState()
    // Repeat-one is excluded on purpose: blending a track into itself is a
    // flange, not a transition. It restarts, as it always did.
    //
    // `playing` rather than `!outgoing.paused`: there is nothing to fade out of
    // if playback is stopped, and the store's intent is the honest source —
    // the element's `paused` lags a pending play() promise.
    const canCrossfade =
      graph !== null &&
      crossfadeSeconds > 0 &&
      repeat !== 'one' &&
      playing &&
      loadedSong.current[activeDeck.current] !== null &&
      loadedSong.current[activeDeck.current] !== currentSong.id

    crossfadeStarted.current = false

    if (!canCrossfade) {
      normalizeDeck(activeDeck.current, currentSong)
      loadInto(activeDeck.current, currentSong.id)
      setCurrentTime(0)
      setDuration(0)
      return
    }

    const incomingDeck: DeckId = activeDeck.current === 'a' ? 'b' : 'a'
    const incoming = deckElement(incomingDeck)
    const outGain = fadeGainFor(activeDeck.current)
    const inGain = fadeGainFor(incomingDeck)
    if (!incoming || !outGain || !inGain) return

    normalizeDeck(incomingDeck, currentSong)
    loadInto(incomingDeck, currentSong.id)
    incoming.currentTime = 0
    // The idle deck has been sitting untouched, so it needs the current
    // playback settings before it becomes audible.
    incoming.volume = outgoing.volume
    incoming.muted = outgoing.muted
    incoming.playbackRate = outgoing.playbackRate
    incoming.preservesPitch = true

    graph!.resume()
    void incoming.play().catch(() => setPlaying(false))

    // Equal-power, not linear: two linear ramps crossing at 0.5 leave a 3 dB
    // hole in the middle of the transition, because uncorrelated signals sum in
    // power. See scheduleEqualPowerFade.
    const now = graph!.context.currentTime
    scheduleEqualPowerFade(outGain.gain, 'out', now, crossfadeSeconds)
    scheduleEqualPowerFade(inGain.gain, 'in', now, crossfadeSeconds)

    activeDeck.current = incomingDeck
    setCurrentTime(0)
    setDuration(0)

    // Stop the outgoing deck once it is inaudible, so it isn't left decoding a
    // silent stream for the rest of the session.
    clearTimeout(fadeTimer.current)
    const faded = outgoing
    fadeTimer.current = setTimeout(() => {
      faded.pause()
    }, crossfadeSeconds * 1000)
  }, [currentSong, activeElement, deckElement, fadeGainFor, loadInto, normalizeDeck, setPlaying])

  // Restart the current track (repeat-one, or "previous" at the queue start).
  useEffect(() => {
    const audio = activeElement()
    if (!audio || restartNonce === 0) return
    audio.currentTime = 0
    graphRef.current?.resume()
    void audio.play().catch(() => setPlaying(false))
  }, [restartNonce, setPlaying, activeElement])

  // Play/pause follows the store.
  useEffect(() => {
    const audio = activeElement()
    if (!audio || !currentSong) return
    if (isPlaying) {
      // The context starts suspended and only a gesture may resume it; this is
      // that gesture's path. Without it the graph would output silence while
      // the element reported itself as playing.
      graphRef.current?.resume()
      // Autoplay can be refused by the browser; reflect reality rather than
      // leaving the UI claiming it's playing.
      void audio.play().catch(() => setPlaying(false))
    } else {
      audio.pause()
      // Pausing records the exact second (#183). The throttled writer during
      // playback is deliberately coarse, and pausing is the moment someone is
      // most likely to close the tab — so it is worth being precise here.
      if (Number.isFinite(audio.currentTime)) {
        lastResumeWrite.current = audio.currentTime
        setResume(currentSong.id, audio.currentTime)
      }
    }
  }, [isPlaying, currentSong, setPlaying, activeElement, setResume])

  // Volume, mute and rate go to *both* decks. Applying them only to the active
  // one would mean a crossfade faded in a track at stale settings.
  useEffect(() => {
    for (const element of Object.values(decks())) {
      if (!element) continue
      element.volume = volume
      element.muted = muted
    }
  }, [volume, muted, decks])

  useEffect(() => {
    for (const element of Object.values(decks())) {
      if (!element) continue
      element.playbackRate = playbackRate
      // Time-stretch rather than pitch-shift: sped-up music should still be in
      // key. This is the browser default, set explicitly so it can't drift.
      element.preservesPitch = true
    }
  }, [playbackRate, currentSong, decks])

  // Sleep timer: fade out over the last few seconds, then pause. The fade is
  // done on the elements rather than in the store so the store stays pure, and
  // the stored volume is restored afterwards — the timer must not silently
  // leave the player muted for next time.
  useEffect(() => {
    if (sleepAt === null) return
    // Captured once: the cleanup must restore the volume on the decks this
    // effect actually faded.
    const faded = Object.values(decks()).filter(
      (element): element is HTMLAudioElement => element !== null,
    )
    const restore = () => {
      for (const element of faded) element.volume = volume
    }

    const remaining = sleepAt - Date.now()
    if (remaining <= 0) {
      setPlaying(false)
      usePlayerStore.getState().setSleepTimer(null)
      return
    }

    const FADE_MS = 5_000
    let fade: ReturnType<typeof setInterval> | undefined

    const fadeTimeout = setTimeout(
      () => {
        const steps = 20
        let step = 0
        fade = setInterval(() => {
          step += 1
          for (const element of faded) {
            element.volume = Math.max(0, volume * (1 - step / steps))
          }
          if (step >= steps && fade) clearInterval(fade)
        }, FADE_MS / steps)
      },
      Math.max(0, remaining - FADE_MS),
    )

    const stopTimer = setTimeout(() => {
      setPlaying(false)
      usePlayerStore.getState().setSleepTimer(null)
      restore()
    }, remaining)

    return () => {
      clearTimeout(fadeTimeout)
      clearTimeout(stopTimer)
      if (fade) clearInterval(fade)
      restore()
    }
  }, [sleepAt, volume, setPlaying, decks])

  // Keep the OS media controls (lock screen, keyboard media keys) in sync.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentSong) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSong.title,
      artist: currentSong.artist,
      album: currentSong.album ?? undefined,
      artwork: [{ src: songCoverUrl(currentSong.id) }],
    })
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [currentSong, isPlaying])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const store = usePlayerStore.getState
    const handlers: [MediaSessionAction, () => void][] = [
      ['play', () => store().setPlaying(true)],
      ['pause', () => store().setPlaying(false)],
      ['previoustrack', () => store().previous()],
      ['nexttrack', () => store().next()],
    ]
    for (const [action, handler] of handlers) {
      navigator.mediaSession.setActionHandler(action, handler)
    }
    return () => {
      for (const [action] of handlers) navigator.mediaSession.setActionHandler(action, null)
    }
  }, [])

  const seek = useCallback(
    (seconds: number) => {
      const audio = activeElement()
      if (!audio) return
      audio.currentTime = seconds
      setCurrentTime(seconds)

      // Arriving at the crossfade window by *seeking* is not the same as
      // arriving by playing. Dragging the bar to the last few seconds means
      // "let me hear the end of this", so the fade is suppressed for the rest
      // of the track and it finishes on the ordinary `ended` transition.
      // Without this, a 12s crossfade turned any click past the 12s-remaining
      // mark into a skip — and two clicks into two skips.
      //
      // Seeking back out re-arms it, so playing on into the window still fades.
      const { crossfadeSeconds } = usePlayerStore.getState()
      const landedInsideWindow =
        crossfadeSeconds > 0 &&
        Number.isFinite(audio.duration) &&
        audio.duration - seconds <= crossfadeSeconds
      crossfadeStarted.current = landedInsideWindow
    },
    [activeElement],
  )

  // Element events, bound to every deck. Events from an idle deck are ignored:
  // during a crossfade the outgoing deck keeps firing timeupdate and would
  // otherwise drag the progress bar backwards, and its `ended` would advance
  // the queue a second time.
  useEffect(() => {
    const elements = Object.values(decks()).filter(
      (element): element is HTMLAudioElement => element !== null,
    )
    if (elements.length === 0) return

    const isActive = (element: HTMLAudioElement) => element === deckElement(activeDeck.current)

    const onTimeUpdate = (event: Event) => {
      const element = event.currentTarget as HTMLAudioElement
      if (!isActive(element)) return
      setCurrentTime(element.currentTime)

      const playing = usePlayerStore.getState().current?.song.id
      if (
        playing != null &&
        element.currentTime - lastResumeWrite.current >= RESUME_WRITE_SECONDS
      ) {
        lastResumeWrite.current = element.currentTime
        setResume(playing, element.currentTime)
      }

      // Start the crossfade before the track actually ends, by advancing the
      // store early — that lands in the effect above, which does the blending.
      const state = usePlayerStore.getState()
      const seconds = state.crossfadeSeconds
      if (
        seconds > 0 &&
        graphRef.current !== null &&
        state.repeat !== 'one' &&
        state.isPlaying &&
        !crossfadeStarted.current &&
        Number.isFinite(element.duration) &&
        element.duration > seconds &&
        element.duration - element.currentTime <= seconds &&
        selectHasNext(state)
      ) {
        crossfadeStarted.current = true
        state.next()
      }
    }

    const onLoadedMetadata = (event: Event) => {
      const element = event.currentTarget as HTMLAudioElement
      if (!isActive(element)) return
      setDuration(element.duration)

      /*
       * Come back to where the last session stopped (#183).
       *
       * Here rather than beside `element.src = ...` because `currentTime` cannot
       * be set until the browser knows the duration — assigning it earlier is
       * silently dropped. Keyed on song id, so a stored position can only ever
       * be applied to the track it came from.
       *
       * `appliedResumeFor` stops a second `loadedmetadata` for the same track
       * yanking playback backwards to a position it has already moved past.
       */
      const { resume, current } = usePlayerStore.getState()
      const songId = current?.song.id
      if (
        resume &&
        songId != null &&
        resume.songId === songId &&
        appliedResumeFor.current !== songId &&
        Number.isFinite(element.duration) &&
        resume.seconds < element.duration
      ) {
        appliedResumeFor.current = songId
        lastResumeWrite.current = resume.seconds
        element.currentTime = resume.seconds
        setCurrentTime(resume.seconds)
      }
    }

    const onEnded = (event: Event) => {
      const element = event.currentTarget as HTMLAudioElement
      if (!isActive(element)) return
      trackEnded()
    }

    for (const element of elements) {
      element.addEventListener('timeupdate', onTimeUpdate)
      element.addEventListener('loadedmetadata', onLoadedMetadata)
      element.addEventListener('ended', onEnded)
    }
    return () => {
      for (const element of elements) {
        element.removeEventListener('timeupdate', onTimeUpdate)
        element.removeEventListener('loadedmetadata', onLoadedMetadata)
        element.removeEventListener('ended', onEnded)
      }
    }
  }, [trackEnded, decks, deckElement, setResume])

  useEffect(() => () => clearTimeout(fadeTimer.current), [])

  return { audioRef, currentTime, duration, seek }
}
