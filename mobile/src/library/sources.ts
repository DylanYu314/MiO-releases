import { isBilibiliLink } from './bilibiliUrl'
import { canReadYouTubeLink } from './youtubeUrl'

/**
 * Which site a link belongs to, and whether this device can fetch it (#492).
 *
 * ## Why this is its own module and a pure function
 *
 * It used to be `canImportOnDevice` in `youtubeUrl.ts`, back when the answer was
 * "YouTube, or nothing". Now there are two sources and the answer *routes* —
 * `importToDevice` picks an extractor from it — so the decision is worth
 * naming, and worth being somewhere a test can hand it every case. The same
 * argument `failureKind.ts` makes: the classification is the part that can be
 * wrong.
 *
 * Both halves are dependency-free URL modules, so a screen asking "can I fetch
 * this" still does not drag `youtubei.js` (1.7 MB of ESM) in behind it.
 */
export type DevicePlatform = 'youtube' | 'bilibili'

/**
 * The site this link belongs to, or null if the device cannot fetch it.
 *
 * **YouTube is asked first**, and the order is not arbitrary: it is by far the
 * common case, and neither matcher can accept the other's URLs, so the order is
 * about cost rather than correctness.
 */
export function platformOf(input: string): DevicePlatform | null {
  if (canReadYouTubeLink(input)) return 'youtube'
  if (isBilibiliLink(input)) return 'bilibili'
  return null
}

/**
 * Whether this phone can fetch the link itself.
 *
 * Since #492 this is two sites rather than one. What it is *not* is "any link
 * yt-dlp supports" — that was the server's promise, and the honest answer here
 * is the list of extractors the app actually carries.
 */
export function canImportOnDevice(input: string): boolean {
  return platformOf(input) !== null
}

/**
 * The i18n key naming the service this link belongs to (#565).
 *
 * ## Why a message needs this at all
 *
 * `failureKind.unavailable` used to begin *"YouTube will not play this one
 * here"* — hardcoded, and shown for every `VideoUnavailable`, including the ones
 * `bilibili.ts` throws for codes `-404`, `-403`, `62002` and `62004`. So a
 * Bilibili refusal was reported as YouTube's, and the advice that follows it —
 * *"another source may work"* — pointed at the source the user had already
 * chosen.
 *
 * That is the worst possible message for exactly the person #551 exists for: a
 * China user, who cannot reach YouTube at all, being told YouTube said no.
 *
 * ## Why it is derived from the URL rather than carried on the error
 *
 * Because the two places that render it — `MatchReview` and `DeviceAddList` —
 * hold a **kind**, not an error. A `FailureKind` is a stored string; by the time
 * it is drawn the exception is long gone. Both of them do have the URL, and
 * `platformOf` is already the app's one answer to "which service is this",
 * so this is the same decision being read rather than a second one being
 * invented.
 *
 * `null` becomes a neutral label rather than a guess: `add/bilibili.tsx` sends
 * links to the server for sites neither extractor knows, and naming one of our
 * two would simply be the same bug wearing different clothes.
 */
export function sourceLabelKey(input: string): string {
  const platform = platformOf(input)
  return platform === null ? 'searchSource.unknown' : `searchSource.${platform}`
}
