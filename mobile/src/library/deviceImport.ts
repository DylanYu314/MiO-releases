import { useDeviceAdds, type DeviceAddPhase, type DeviceAddSource } from '../api/deviceAdds'
import { describeError, logError, logInfo, logWarn } from '../diagnostics/log'
import { classifyFailure } from './failureKind'
import i18n from '../i18n'
import { extractBilibiliAudio, reportRefusal, sourceUrlFor } from './bilibili'
import { platformOf, sourceLabelKey } from './sources'
import { CLIENT_CHAIN, VideoUnavailable, extractAudio, type ExtractedAudio } from './extract'
import {
  DownloadWasShort,
  downloadAudioFromUrl,
  removeSongIfEmpty,
  saveCover,
  saveDeviceSongMetadata,
} from './songs'

/**
 * Adding a song without the server touching the audio (#246).
 *
 * The same shape as `handover.ts`, and the point is what is missing: no job, no
 * `X-Install-Id`, no `/songs/{id}/audio`. The device asks YouTube directly and
 * writes the result to its own library, so the server never holds the bytes.
 *
 * That is what makes "music is stored on the user's device" literally true
 * rather than a storage policy — and it is what retires #221, since there is no
 * server copy left to delete, no receipt to confirm, and no second-device
 * question to answer.
 *
 * ## The client chain has to cover the download, not just the extraction
 *
 * The first version on a real phone failed with **403** from googlevideo, and
 * the reason is worth keeping: a stream URL is tied to the client that asked
 * for it, and the `User-Agent` is checked again when the bytes are fetched.
 * Extracting as the iOS app and downloading as expo-file-system is introducing
 * yourself twice under different names.
 *
 * The headers fix that. This loop covers what headers cannot: a URL that is
 * refused anyway is exactly as useless as no URL, so a failed download retires
 * that client and tries the next rather than failing the whole import.
 *
 * ## The order is the same as the server path, for the same reason
 *
 * Metadata first with `file_uri` null, then the download, then the file is
 * recorded. A failed download leaves a **visible, retryable row** rather than
 * nothing, and `file_uri` set stays a fact about the disk instead of a hope.
 */

/**
 * Where an import has got to (#240).
 *
 * Phases, not a percentage, and that **stopped being forced** with #454. The
 * old reason was real: `downloadAudioFromUrl` made one bounded request and read
 * the whole body, so there was no second read to count bytes with and "47%"
 * would have been a number invented to look reassuring. The download is chunked
 * now and every chunk is a genuine progress point, so a percentage is finally
 * available to whoever wants to show one. Nothing here asks for it yet.
 *
 * `attempt` is 1-based and only interesting above 1: it means a client was
 * refused and the next one is being tried, which is the difference between a
 * slow import and a stuck one.
 */
export interface DeviceImportProgress {
  phase: 'extracting' | 'downloading' | 'saving'
  attempt: number
  /** The YouTube client this attempt is using — null before extraction answers. */
  client: string | null
}

export interface DeviceImportOptions {
  onProgress?: (progress: DeviceImportProgress) => void
  /** Which page the user was on, so its own list can show its own adds (#318). */
  source?: DeviceAddSource
}

export interface DeviceImportResult {
  /** This device's id for the song — what everything local keys on. */
  local_id: string
  title: string
  artist: string
  /** Which YouTube client answered, so a support question has an answer. */
  client: string
}

/**
 * The three things that differ between one source and another (#492).
 *
 * Everything else in the loop below — the record, the row, the download, the
 * cover, the removal of a row whose audio never arrived — is identical, and
 * duplicating it per site is how the two would drift apart.
 *
 * `attempts` is the length of the client chain for YouTube, where a refused
 * stream URL is retired and the next client tried. Bilibili has **one** way in,
 * so its budget is one pass and the outer caller's retry is what buys it time.
 */
export interface DeviceExtractor {
  platform: string
  attempts: number
  /** `exclude` is the clients already refused; meaningless where there is only
   *  one, and passed anyway so the two shapes stay the same. */
  extract: (exclude: string[]) => Promise<ExtractedAudio>
  /**
   * The library's identity for this video.
   *
   * Never the stream URL, and never the link that was pasted: it is the
   * canonical page, because `songs.source_url` is UNIQUE since v6 and two
   * spellings of one video must not become two rows.
   */
  sourceUrl: (audio: ExtractedAudio) => string
}

/**
 * Which extractor this URL needs — the single decision, exported (#555).
 *
 * `importToDevice` is not the only loop that fetches audio: the review-based
 * playlist imports (Spotify, NetEase, and QQ/Kugou after #103/#104) run their
 * own, because they retry, pace and order across a whole playlist. That loop
 * called `extractAudio` directly and so could only ever download YouTube — a
 * Bilibili match threw `NotAYouTubeLink` before a single request was made, and
 * #551's toggle found music the user could not fetch.
 *
 * Exported rather than duplicated: one reading of `platformOf`, so a third
 * source cannot arrive in one loop and not the other.
 */
export function extractorFor(url: string): DeviceExtractor {
  if (platformOf(url) === 'bilibili') {
    return {
      platform: 'Bilibili',
      attempts: 1,
      extract: () => extractBilibiliAudio(url),
      sourceUrl: sourceUrlFor,
    }
  }
  return {
    platform: 'Youtube',
    attempts: CLIENT_CHAIN.length,
    extract: (exclude) => extractAudio(url, { exclude }),
    // The watch URL, not the stream URL. Stream URLs expire within hours and
    // are tied to the requesting address, so storing one would leave a row
    // pointing at something that stops existing.
    sourceUrl: (audio) => `https://www.youtube.com/watch?v=${audio.video_id}`,
  }
}

/**
 * Import one link straight onto this device.
 *
 * **YouTube or Bilibili**, decided here rather than by the caller (#492).
 * `useDownloadSong`, add-link, the Search tab and `listImport.ts` all call this
 * bare with a URL — routing inside meant every one of them gained the second
 * source without changing a line.
 *
 * ⚠️ **The review-based playlist imports do not call this**, and the claim that
 * they did stood in this docblock until #555. `playlistImport.ts` runs its own
 * loop — it retries, paces and orders across a whole playlist — and it shares
 * only the *decision*, via {@link extractorFor}. A change to routing has two
 * callers, not one.
 *
 * Throws if extraction or the download fails. The caller decides whether to
 * retry; the row survives either way, so a failure is visible in the library
 * rather than a song that silently never appeared.
 */
export async function importToDevice(
  url: string,
  { onProgress, source = 'link' }: DeviceImportOptions = {},
): Promise<DeviceImportResult> {
  const extractor = extractorFor(url)
  const refused: string[] = []
  let lastError: unknown = null
  /** A rate a previous attempt actually achieved, from `DownloadWasShort`. */
  let observedRate: number | null = null

  /*
   * Recorded here rather than in each screen (#318).
   *
   * Add-link and search both call this, and both used to keep the outcome in
   * component state — so leaving the screen lost it and quitting mid-download
   * lost it completely. One writer means the record cannot disagree with what
   * actually happened, and a screen that never mounts again still gets it
   * right.
   */
  const record = useDeviceAdds.getState()
  record.started(url, source)

  /**
   * Report to the caller *and* to the durable record (#430).
   *
   * The record was the only thing that survived leaving the screen, and it knew
   * nothing but `working` — so tapping an un-downloaded library track gave a
   * bare spinner over what can honestly be twenty minutes of work: four clients,
   * each with a download bounded at five minutes. `onProgress` already carried
   * exactly the right information and only ever reached a component, and the
   * library path (`useDownloadSong`) passes no callback at all.
   */
  const report = (phase: DeviceAddPhase, attempt: number, client: string | null): void => {
    onProgress?.({ phase, attempt, client })
    useDeviceAdds.getState().progressed(url, { phase, attempt, attempts: extractor.attempts })
  }
  // The *source*, never the URL. Which page an add came from is a fact about
  // the app; the URL is a fact about the user's taste (#354).
  logInfo('import.started', source)

  // Bounded by the chain: each pass either succeeds or retires one client.
  // One pass for a source that has one way in.
  for (let attempt = 0; attempt < extractor.attempts; attempt++) {
    report('extracting', attempt + 1, null)
    let audio: ExtractedAudio
    try {
      audio = await extractor.extract(refused)
    } catch (error) {
      // Named while it still has its type, for the log only (#492): a 412 is
      // Bilibili saying the request looked wrong, and the device pass needs to
      // be able to see that rather than infer it.
      reportRefusal(error)
      // Extraction ran out of clients. If a *download* already failed, that
      // error is the useful one and this would bury it — which is exactly what
      // happened on the second real-device attempt: the message said "no client
      // could provide audio", listing the clients that had no format, while the
      // HTTP status from the client that did was thrown away.
      if (lastError) break
      useDeviceAdds.getState().failed(url, messageFor(error, url), classifyFailure(error))
      logError('import.extractFailed', describeError(error))
      throw error
    }

    // Named as soon as extraction answers, so a record mid-download is a song
    // rather than a URL.
    useDeviceAdds
      .getState()
      .describe(url, { title: audio.title, artist: audio.artist, thumbnail: audio.cover_url })

    const localId = await saveDeviceSongMetadata({
      title: audio.title,
      artist: audio.artist,
      duration: audio.duration,
      // The canonical page for this video, whatever was pasted — it is what
      // identifies the same video on a re-import.
      source_url: extractor.sourceUrl(audio),
      source_platform: extractor.platform,
      // Loudness normalization survives the move off the server (#246): YouTube
      // ships the measurement, so nothing has to run `ebur128` on the phone.
      loudness_lufs: audio.loudness_lufs,
    })

    try {
      report('downloading', attempt + 1, audio.client)
      await downloadAudioFromUrl(localId, audio.audio_url, audio.http_headers, {
        contentLength: audio.content_length,
        observedBytesPerSecond: observedRate,
        // A URL that stops serving mid-file is replaced rather than lost
        // (#454). Same client: this is about a spent URL, not a refused
        // video, and the size check inside rejects a different format.
        // Through the extractor, not `extractAudio`: a Bilibili download that
        // needed a refresh used to throw `NotAYouTubeLink` here (#555).
        refresh: async () => {
          const next = await extractor.extract(refused)
          return {
            url: next.audio_url,
            headers: next.http_headers,
            contentLength: next.content_length,
          }
        },
      })
      // After the audio and never before it (#218): the song is complete at the
      // line above, and `saveCover` swallows its own failures so a missing
      // thumbnail cannot cost the user a track it already downloaded.
      report('saving', attempt + 1, audio.client)
      await saveCover(localId, audio.cover_url)
      useDeviceAdds.getState().succeeded(url)
      // Which client served it is the diagnostic. The title is not.
      logInfo('import.succeeded', `via ${audio.client}`)
      return { local_id: localId, title: audio.title, artist: audio.artist, client: audio.client }
    } catch (error) {
      /*
       * The row goes with it (#309).
       *
       * It used to survive on purpose — "the song shows as known but not
       * downloaded, which is a state the schema models and the user can act
       * on". I re-took that decision: the library means *music I have*, and
       * a row with no file is a promise it cannot keep. What a user can act on is
       * the record on the page they added it from, which now exists.
       *
       * Guarded, so a re-download of a track that is already here cannot delete
       * it: only a row with nothing behind it is removed.
       */
      await removeSongIfEmpty(localId)
      // Per attempt, not per import: which client refused and why is the
      // question every download bug so far has turned on.
      logWarn('import.clientRefused', `${audio.client}: ${describeError(error)}`)
      lastError = error
      if (error instanceof DownloadWasShort) {
        // Kept, and its rate carried: a client that delivered megabytes and ran
        // out of time is the only one serving us, not one refusing us (#439).
        // Retiring it is what sent the four failed tracks to clients that had
        // already answered 403 at byte 0.
        observedRate = error.observedBytesPerSecond ?? observedRate
      } else {
        refused.push(audio.client)
      }
    }
  }

  const failure = new Error(
    `Downloaded nothing for ${url}. Refused by ${refused.join(', ') || 'no client'}. ` +
      `Last download error: ${String(lastError)}`,
  )
  useDeviceAdds
    .getState()
    .failed(url, messageFor(lastError ?? failure, url), classifyFailure(lastError ?? failure))
  /*
   * Built from the refusals rather than reusing `failure.message`, which embeds
   * the URL because it is written for the person looking at the screen. The log
   * is written for a server, and the server has no business knowing what they
   * tried to add (#354).
   *
   * ⚠️ **And the last error with it** (#582). Excluding the URL was a decision;
   * excluding the *status* was a side effect of how this line was built, and it
   * cost a diagnosis: "refused by ANDROID_VR_DIRECT, ANDROID_VR, IOS,
   * TV_SIMPLY" is the same sentence for a 403 at byte 0, a 403 after the first
   * megabyte and a timeout eight megabytes in — three different faults with
   * three different answers. A status and a byte offset identify nothing about
   * the track, and `scrub()` still runs over the whole line.
   */
  logError(
    'import.failed',
    `refused by ${refused.join(', ') || 'no client'}` +
      (lastError ? ` — ${describeError(lastError)}` : ''),
  )
  throw failure
}

/** The part of an error worth showing someone, or null. */
function messageFor(error: unknown, url: string): string | null {
  /*
   * The one failure a user can actually do something about (#400).
   *
   * Everything else here is written for whoever is debugging — client names,
   * HTTP statuses — and that is right, because there is nothing to act on. A
   * video YouTube will not play for us is different: the answer is "find it
   * somewhere else", and "no client could provide audio for Kvv5CpePWk0 —
   * ANDROID_VR: no audio format; IOS: no audio format; …" does not say so.
   */
  if (error instanceof VideoUnavailable) {
    // Named, rather than assumed to be YouTube (#565). `bilibili.ts` throws this
    // too — for codes -404, -403, 62002 and 62004 — and telling a user who chose
    // Bilibili that *YouTube* refused them is the most confusing sentence this
    // app could produce for the one person #551 was built for.
    return i18n.t('deviceAdds.unavailable', { source: i18n.t(sourceLabelKey(url)) })
  }
  /*
   * The second failure a user can act on, and the docblock above said there was
   * only one (#639).
   *
   * That was true when it was written and has expired: a 403 at byte 0 on every
   * client has now been seen four times, and it clears on its own within about
   * twenty minutes. So the honest advice is *wait and try again*, and what the
   * user got instead was the developer's sentence — "Refused by
   * ANDROID_VR_DIRECT, ANDROID_VR, IOS, TV_SIMPLY. Last download error: Error:
   * Download refused with status 403 at byte 0" — four client names and an HTTP
   * status, saying nothing they can use.
   *
   * The **same string** `DeviceAddList` renders for the kind, so the row and
   * this line cannot say different things about one failure.
   */
  if (classifyFailure(error) === 'refused_at_start') {
    return i18n.t('failureKind.refused_at_start', { source: i18n.t(sourceLabelKey(url)) })
  }
  if (error instanceof Error) return error.message
  const text = String(error)
  return text === 'undefined' || text === 'null' ? null : text
}
