/**
 * A track list this device fetched from a music service (ADR-013).
 *
 * NetEase Cloud Music (#102), and QQ Music (#103) and Kugou (#104) after it.
 * All three hand back **titles and artists** rather than exact ids, so every
 * track still has to be found on YouTube — which is the Spotify pipeline, and
 * emphatically not `listImport.ts`, whose loop walks a list of ids and has
 * nothing to guess.
 *
 * ## Why the phone fetches this and the server does not
 *
 * The issues describe a server-side import. ADR-013 decision 2 moved it here:
 * whether a Frankfurt address can read a Chinese music API is unmeasured and
 * does not need to be if the connection asking is the user's own (#177 is what
 * happens when it is the droplet's), and these endpoints are undocumented, so a
 * break is repairable over the air in a minute (#412) rather than by a deploy.
 *
 * ## Never their audio
 *
 * ADR-013 decision 1, and the reason this type has no URL field for a stream.
 * Every fetcher calls its service's **metadata** endpoint, which returns no
 * audio URL at all — rather than an extractor that resolves one and is then
 * trusted to ignore it. `__tests__/externalFetchersAvoidAudio.test.ts` reads the
 * sources and fails if an audio host ever appears in one.
 */

/** One track, in the shape `TrackMatch` stores and `matching.py` scores. */
export type ExternalTrack = {
  /** The track's id at its source. Kept so a row can be recognised again. */
  externalId: string | null
  title: string
  /**
   * The artist, or `''` when the source did not give one.
   *
   * Empty is a real answer rather than a missing one — Kugou glues artist and
   * title into a single `filename` and the split can fail. It costs the track
   * its chance of auto-matching (the score caps at 0.70 without an artist,
   * under the 0.80 threshold), which sends it to review. That is the correct
   * outcome for a guess made with less information.
   */
  artist: string
  album: string | null
  /** Seconds. `null` when the source did not give one — the scorer treats an
   *  unknown duration as neutral rather than as a mismatch. */
  durationSeconds: number | null
}

/** A whole playlist, ready to become a `PlaylistImport`. */
export type ExternalPlaylist = {
  /** The service slug stored on the import, e.g. `netease`. Free-form on the
   *  server on purpose, so a fourth source is an app-only change. */
  service: string
  /** The canonical URL of the playlist at its source. */
  sourceUrl: string
  name: string
  tracks: ExternalTrack[]
}

/**
 * A source refused us, or answered something we cannot use.
 *
 * Its own type so a screen can tell "this playlist is private / gone" from a
 * dropped connection. ADR-013's consequence about surfacing a refusal **as a
 * refusal**: an empty playlist and a rejected request must never look alike,
 * because only one of them is worth retrying.
 */
export class ExternalSourceRefused extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ExternalSourceRefused'
    this.code = code
  }
}

/**
 * A playlist came back shorter than the source said it was.
 *
 * ADR-013 requires this check: all three sources state their own track count,
 * and importing a silently truncated playlist is worse than failing, because
 * nothing later in the pipeline can tell that anything is missing.
 */
export class ExternalPlaylistTruncated extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`Playlist reported ${expected} tracks and only ${received} could be read`)
    this.name = 'ExternalPlaylistTruncated'
  }
}
