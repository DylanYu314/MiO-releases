import { describeError, logInfo, logWarn } from '../diagnostics/log'
import { searchOnDeviceQuietly } from './deviceSearch'
import { buildSearchQuery, classify, scoreCandidates } from './matching'
import {
  countMatchesByStatus,
  getImport,
  listMatches,
  setMatchCandidates,
  updateImport,
  type LocalPlaylistImport,
} from './playlistImports'
import { currentSearchSource } from './searchSource'

/**
 * Finding each Spotify track on YouTube, from the phone (#353).
 *
 * The second half of what #246 started, and the one that kept my phone
 * pointed at my laptop. A Spotify import gets its tracklist from Spotify —
 * which does not refuse a datacenter — and then has to find each track on
 * YouTube, which does: **1 request in 14** from the droplet (#177), unchanged
 * by a proof-of-origin provider, a JavaScript runtime or a cookie file.
 *
 * *"what if real user is using the app, i got keep my laptop on all the
 * time and be next to them, impossible."*
 *
 * ## The search moved and the scorer did not
 *
 * This searches; the server scores what it finds, with the same
 * `score_candidates` that the server-side matching phase uses. That was a
 * deliberate choice over porting the matcher: a TypeScript twin of
 * `matching.py` would have to agree with it forever, across thresholds,
 * Unicode normalisation and `rapidfuzz`'s `token_set_ratio`, and nothing would
 * tell us the day it stopped. One scorer cannot drift from itself.
 *
 * So the phone is the *network* the server does not have, not a second brain.
 *
 * ## Which platform it searched travels with the candidates (#551)
 *
 * Since the source became a choice, the server can no longer assume a candidate
 * is a YouTube one — and it must not, because `_TOPIC_BONUS` is a YouTube
 * naming convention worth +0.05 that no Bilibili uploader can earn (ADR-013
 * decision 4). The source is read **once per run** rather than per track, so a
 * user flipping the toggle mid-import cannot produce a batch whose candidates
 * disagree with each other about where they came from.
 *
 * ## ⚠️ The query is no longer built here, and the copy that was had drifted
 *
 * This module used to carry `searchQueryFor`, labelled *"kept identical on
 * purpose"* and described in this docblock as `f"{artist} {title}"`. **That
 * description of `matching.py` was wrong**, and had been since it was written:
 *
 *     primary_artist = artist.split(",")[0].strip()
 *     return f"{primary_artist} {title}".strip()
 *
 * The server drops everything after the first comma — *"feat-lists just add
 * noise"* — and the device did not. So every multi-artist track was searched
 * with a noisier query than the scorer was designed for, on every review-based
 * import since #353 (#618).
 *
 * Nothing compared the two, so the comment asserting the invariant was the only
 * thing that ever checked it. It calls `buildSearchQuery` from `matching.ts`
 * now, which is a real port pinned by `shared/matching-golden.json` — so the
 * two cannot drift again without a test failing.
 */

/** How many candidates to offer per track.
 *
 *  `CANDIDATE_LIMIT` in `matching.py`, and the same number for the same reason:
 *  the review screen shows a handful of alternatives, and scoring more of them
 *  costs a phone bandwidth to no visible end. */
const CANDIDATE_LIMIT = 5

/*
 * ⚠️ `BATCH_SIZE` and `MATCHES_PAGE_SIZE` were here and are deleted (#611).
 *
 * Both existed for the round trip: ten tracks per POST so progress was visible
 * in tenths rather than at the end, and two hundred matches per page because
 * that was the endpoint's ceiling. Neither means anything against SQLite —
 * rows settle one at a time, which is strictly better, and there is no page.
 */

export interface MatchingProgress {
  /** Tracks searched so far, 1-based once work has started. */
  current: number
  total: number
}

/**
 * Search for every unmatched track in an import and post what was found.
 *
 * Returns the import as the server last reported it, which is `review` once
 * every track has been answered for.
 *
 * Resumable by construction: it asks the server which tracks are still
 * `pending` rather than keeping a list of its own, and the endpoint re-scores
 * anything it is sent twice. So an import interrupted half way through is
 * finished by calling this again — which matters, because a forty-track search
 * on a phone is long enough to be interrupted.
 */
export async function supplyCandidates(
  importId: string,
  { onProgress }: { onProgress?: (progress: MatchingProgress) => void } = {},
): Promise<LocalPlaylistImport | null> {
  const pending = await listMatches(importId, 'pending')
  // Once, not per track: see the note in the module docblock.
  const source = currentSearchSource()
  logInfo('matching.started', `${pending.length} track(s) on device via ${source}`)

  let searched = 0
  let refusal: unknown = null

  for (const match of pending) {
    onProgress?.({ current: searched + 1, total: pending.length })

    let results
    try {
      // Quietly: one track nobody can search for must degrade that row and
      // never the run. An empty list is what marks it `no_match` rather than
      // leaving it pending.
      results = await searchOnDeviceQuietly(
        buildSearchQuery(match.title, match.artist),
        CANDIDATE_LIMIT,
        source,
      )
    } catch (error) {
      /*
       * The source is refusing this address (#586). Every remaining track would
       * get the same answer, one second apart, and each would be filed as "no
       * candidate found" — which is what turned a rate limit into a playlist of
       * failures having nothing to do with the tracks.
       *
       * Everything scored so far is already written, one row at a time, so
       * stopping here throws nothing away. That is the one thing the local
       * version is strictly better at than the batched POST it replaced.
       */
      refusal = error
      break
    }

    /*
     * Scored **here** since #609.
     *
     * This used to POST the results to `/playlist-imports/{id}/candidates` and
     * let `matching.py` score them — deliberately, because #353 held that "one
     * matcher cannot drift from itself". `matching.ts` is a real port of that
     * scorer pinned by `shared/matching-golden.json`, and both suites assert
     * against the same corpus, so the guarantee survives the server leaving.
     */
    const scored = scoreCandidates(
      match.title,
      match.artist,
      match.duration_s,
      // `source` is stamped on each result rather than on the batch, because
      // that is the shape the scorer reads — one candidate, one origin, and
      // `_TOPIC_BONUS` is gated on it (#552).
      results.map((result) => ({ ...result, source })),
    )
    const best = scored.length > 0 ? scored[0].score : null
    await setMatchCandidates(match.id, scored, classify(best))
    searched += 1
  }

  /*
   * The counters, from the rows rather than from the loop.
   *
   * #585's shape: a count kept alongside the work drifts from the work the
   * moment anything is skipped, and then "4/4 done" is printed over an
   * eighteen-track playlist. These are a `GROUP BY`.
   */
  const counts = await countMatchesByStatus(importId)
  const stillPending = counts.pending ?? 0
  const rows = Object.values(counts).reduce((total, count) => total + count, 0)
  /*
   * ⚠️ **`rows > 0` is not belt and braces.**
   *
   * Without it an import with no track rows — one whose fetch has not written
   * them yet — is declared reviewable the moment this runs, because "nothing is
   * pending" is trivially true of nothing. The screen then jumps from a
   * progress bar to an empty review.
   *
   * And `stillPending === 0` on its own: a run stopped by a refusal must stay
   * in `matching`, or the resume would never start.
   */
  const settled = rows > 0 && stillPending === 0
  if (rows > 0) {
    // ⚠️ The counter is guarded too, not only the status. Writing it from an
    // empty table sets `matched_count` to 0 and wipes whatever the fetch phase
    // had recorded — the screen then reads "0 of 40" for an import that had
    // counted 12.
    await updateImport(importId, {
      matched_count: (counts.auto_matched ?? 0) + (counts.needs_review ?? 0),
      ...(settled ? ({ status: 'review' } as const) : {}),
    })
  }

  if (refusal) {
    logWarn('matching.refused', describeError(refusal))
    throw refusal
  }

  logInfo('matching.finished', `${searched} searched, ${stillPending} still pending`)
  return getImport(importId)
}

/*
 * `supplyCandidatesQuietly` was here and is deleted (#586).
 *
 * Nothing called it — not a screen, not a test — and it did exactly the thing
 * this change exists to stop: caught every failure from the run and wrote it to
 * the log. Leaving an unused "quiet" variant next to a loop whose whole point
 * is that a source refusal must **not** be swallowed is a trap, and the next
 * person wiring up a screen would reasonably reach for it.
 *
 * The screen catches it now, which is where the decision belongs: it is the
 * only thing that can tell the user to wait.
 */
