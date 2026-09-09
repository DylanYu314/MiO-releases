import { describeError, logInfo, logWarn } from '../diagnostics/log'
import { extractAudio } from './extract'

/**
 * Does a googlevideo URL serve a **partial** range, and does it serve twice?
 *
 * ## Why this exists
 *
 * Three decisions are waiting on one unmeasured fact (#442):
 *
 * 1. **Can a paused download resume?** If a freshly extracted URL will serve
 *    `Range: bytes=N-`, pause can mean pause. If not, it can only mean cancel,
 *    and a user who pauses a forty-minute download loses forty minutes.
 * 2. **Can a long track be chunked?** An hour-long video is ~85 MB, and the
 *    current path holds the whole body in a JS `ArrayBuffer` before writing it.
 *    That will run out of memory long before any timeout matters.
 * 3. **Can a dropped connection be recovered from** rather than restarted?
 *
 * What #246 established is narrower than it is usually quoted as: **a second
 * request on the *same* URL is refused.** That is why the downloader makes one
 * bounded request. It says nothing about a *fresh* URL asked for a mid-file
 * range — and that is the case all three questions actually turn on.
 *
 * ## Why it must run on the phone
 *
 * A stream URL is tied to the address that asked for it. Measuring this from a
 * laptop or the droplet measures the wrong network — #177 is the whole history
 * of that mistake. It has to come from the residential connection the app
 * actually downloads on.
 *
 * ## Why it asks two questions, not one
 *
 * A probe that only tried the fresh-URL range could not tell "ranges are
 * refused" from "this particular URL was already spent". So it does both, and
 * the pair is what makes either answer interpretable — the control matters as
 * much as the experiment.
 */

/** How much of the tail to actually pull. Enough to prove bytes are flowing,
 *  small enough that the probe is a moment rather than an afternoon (#457). */
const PROBE_WINDOW_BYTES = 1024 * 1024

export interface RangeProbeResult {
  /** What a fresh URL said to `Range: bytes=<half>-`. */
  freshRangeStatus: number | null
  /** Bytes it actually returned for that half-file request. */
  freshRangeBytes: number | null
  /** Its `Content-Range` header, which is the unambiguous answer. */
  contentRange: string | null
  /** What the **same** URL said to a second request. #246 predicts a refusal. */
  secondRequestStatus: number | null
  /** The size the extractor reported, for scale. */
  contentLength: number | null
  error: string | null
}

/** A summary short enough for a log line and complete enough to act on. */
export function describeRangeProbe(result: RangeProbeResult): string {
  if (result.error) return `failed: ${result.error}`
  const resumable =
    result.freshRangeStatus === 206 && result.freshRangeBytes !== null && result.freshRangeBytes > 0
  return (
    `fresh=${result.freshRangeStatus ?? '?'} bytes=${result.freshRangeBytes ?? '?'}` +
    ` contentRange=${result.contentRange ?? 'none'}` +
    ` second=${result.secondRequestStatus ?? '?'}` +
    ` of=${result.contentLength ?? '?'}` +
    ` resumable=${resumable}`
  )
}

/**
 * Ask a fresh URL for the second half of the file, then ask it again.
 *
 * Never throws: it is a diagnostic, and one that could take the screen down
 * with it would be worse than none.
 */
export async function probeRangeSupport(watchUrl: string): Promise<RangeProbeResult> {
  const result: RangeProbeResult = {
    freshRangeStatus: null,
    freshRangeBytes: null,
    contentRange: null,
    secondRequestStatus: null,
    contentLength: null,
    error: null,
  }

  try {
    // A **fresh** extraction, which is the whole point: the question is about a
    // URL that has not been spent, not about re-using one.
    const audio = await extractAudio(watchUrl)
    result.contentLength = audio.content_length ?? null

    const half = Math.floor((audio.content_length ?? 2_000_000) / 2)
    /*
     * A **bounded** window, not the whole tail (#457).
     *
     * This asked for `bytes=<half>-` and then read the entire remainder into
     * memory to count it. On the 2h54m track I tested that is **93 MB and
     * fifty minutes of waiting** for a yes/no answer — and a diagnostic that
     * costs fifty minutes will not be run twice, which is the actual failure.
     *
     * The question is unchanged: a server that honours `bytes=<half>-<half+1MB>`
     * is a server that honours ranges. `Content-Range` carries the whole answer
     * on its own; the byte count is corroboration and does not need to be the
     * entire file to corroborate anything.
     */
    const first = await fetch(audio.audio_url, {
      headers: { ...audio.http_headers, Range: `bytes=${half}-${half + PROBE_WINDOW_BYTES - 1}` },
    })
    result.freshRangeStatus = first.status
    result.contentRange = first.headers.get('Content-Range')
    if (first.ok) {
      result.freshRangeBytes = (await first.arrayBuffer()).byteLength
    }

    /*
     * The control. #246 says this is refused, and if it is *not* refused then
     * the single-request design is more conservative than it needs to be — which
     * is worth knowing on its own. Asked second so it cannot affect the answer
     * above.
     */
    const second = await fetch(audio.audio_url, {
      headers: { ...audio.http_headers, Range: 'bytes=0-1023' },
    })
    result.secondRequestStatus = second.status
    // Read and discard, so the connection is not left half-open.
    await second.arrayBuffer().catch(() => undefined)
  } catch (error) {
    result.error = describeError(error)
  }

  // The URL is never logged: it is a fact about the user's taste (#354).
  const line = describeRangeProbe(result)
  if (result.error) logWarn('probe.range', line)
  else logInfo('probe.range', line)
  return result
}
