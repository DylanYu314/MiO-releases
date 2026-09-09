/**
 * Reading a Bilibili video out of whatever was pasted (#492).
 *
 * Its own module with no dependencies, for the same reason `youtubeUrl.ts` is
 * one: "is this a Bilibili link" is a question screens ask, and importing it
 * from `bilibili.ts` would be enough to drag the extractor into any screen that
 * wanted the answer.
 *
 * ## Two id schemes, and the canonical one is `BV`
 *
 * A video has a numeric `aid` (`av170001`) and a string `bvid` (`BV1xx411c7mD`).
 * Both address the same video and both appear in the wild — Bilibili's own
 * **search results** hand back `arcurl` in the `av` form, so this will matter
 * again as soon as search lands.
 *
 * Everything is canonicalised to `BV` before it reaches the library, because
 * `songs.source_url` is UNIQUE since v6 and is what makes "do I already have
 * this" answerable. Two spellings of one video must not become two rows. An
 * `av` link therefore costs nothing extra: the `view` call has to happen anyway
 * and it returns the `bvid`.
 */

export class NotABilibiliLink extends Error {
  constructor(input: string) {
    super(`Not a Bilibili link: ${input}`)
    this.name = 'NotABilibiliLink'
  }
}

/** A video named the way the caller happened to have it. */
export type BilibiliRef = ({ bvid: string } | { aid: string }) & {
  /**
   * Which part of a multi-part video the link names, 1-based, or undefined
   * (#575).
   *
   * Bilibili calls these 多P: one upload split into numbered parts, each with
   * its own `cid`, its own title and its own duration. A link to one carries
   * `?p=N`, and MiO read it as far as the `BV` id and then always fetched part
   * **one** — so pasting a link to part 3 of an album silently downloaded part
   * 1, under the whole video's title.
   *
   * Measured on `BV1r84y1e77t` (33 parts) 2026-08-17: every page row carries
   * `page`, `cid`, `part` and `duration`, and the view's top-level `cid` is
   * exactly `pages[0].cid` — which is why the old code was always part one
   * rather than sometimes right.
   */
  part?: number
}

/** `BV` followed by ten of Bilibili's alphabet. Case is preserved rather than
 *  normalised: a `bvid` is case-sensitive. */
const BVID = /^BV[0-9A-Za-z]{10}$/
const AVID = /^av(\d+)$/i

/** `b23.tv/xxxx` — a redirect, so it cannot be read without a request. */
const SHORT_HOST = /^(?:www\.)?b23\.tv$/i
const MAIN_HOST = /^(?:www\.|m\.)?bilibili\.com$/i

function hostOf(input: string): string | null {
  try {
    return new URL(input.trim()).hostname
  } catch {
    return null
  }
}

/**
 * Whether this needs resolving before anything else can be read from it.
 *
 * A short link is still a Bilibili link — `isBilibiliLink` says yes — but it
 * carries no video id at all, so {@link refFrom} refuses it and the extractor
 * resolves it first.
 */
export function isShortLink(input: string): boolean {
  const host = hostOf(input)
  return host !== null && SHORT_HOST.test(host)
}

/**
 * The video this input names. Throws rather than guessing.
 *
 * Deliberately refuses a `b23.tv` link: there is no id in one, and returning
 * something plausible would be worse than saying so.
 */
export function refFrom(input: string): BilibiliRef {
  const trimmed = input.trim()

  // A bare id, which is what a `source_url` round-trip and a test both produce.
  if (BVID.test(trimmed)) return { bvid: trimmed }
  const bare = AVID.exec(trimmed)
  if (bare) return { aid: bare[1] }

  const host = hostOf(trimmed)
  if (host === null || !MAIN_HOST.test(host)) throw new NotABilibiliLink(input)

  const url = new URL(trimmed)
  const part = partFrom(url)

  // `/video/BV…`, `/video/av…`, with or without a trailing part or query.
  for (const segment of url.pathname.split('/')) {
    if (BVID.test(segment)) return { bvid: segment, part }
    const numeric = AVID.exec(segment)
    if (numeric) return { aid: numeric[1], part }
  }

  // A `?bvid=` festival link, which is the one shape yt-dlp carries a separate
  // pattern for.
  const fromQuery = url.searchParams.get('bvid')
  if (fromQuery && BVID.test(fromQuery)) return { bvid: fromQuery, part }

  throw new NotABilibiliLink(input)
}

/**
 * `?p=N`, when it names a real part (#575).
 *
 * `undefined` rather than 1 for a missing or unusable value, and the difference
 * is load-bearing: it is what keeps an ordinary single-part link's canonical
 * URL free of a `?p=1` that would make it a different row from the same link
 * pasted yesterday.
 *
 * `p=0`, `p=-2` and `p=two` are all treated as absent rather than as errors. A
 * link that is otherwise perfectly good should not be refused over a query
 * parameter Bilibili itself ignores.
 */
function partFrom(url: URL): number | undefined {
  const raw = url.searchParams.get('p')
  if (raw === null) return undefined
  const part = Number(raw)
  return Number.isInteger(part) && part > 0 ? part : undefined
}

/**
 * Whether the device should treat this as Bilibili at all.
 *
 * True for a short link, which has no id yet — the extractor resolves it. The
 * question this answers is *which site*, not *which video*.
 */
export function isBilibiliLink(input: string): boolean {
  if (isShortLink(input)) return true
  try {
    refFrom(input)
    return true
  } catch {
    return false
  }
}

/**
 * The one URL the library stores for a video.
 *
 * Every path ends here, so an `av` link, a `BV` link, a short link and a search
 * result all produce the same `source_url` — and therefore the same row.
 */
export function canonicalUrlFor(bvid: string, part?: number): string {
  const base = `https://www.bilibili.com/video/${bvid}`
  /*
   * ⚠️ The part belongs in the identity (#575).
   *
   * `songs.source_url` is UNIQUE since v6, so without this every part of a
   * multi-part upload would be the same row — importing part 2 after part 1
   * would collide with it and the user would end up with one track for what
   * they asked for twice.
   *
   * Omitted for part 1 and for no part at all, so the ordinary link's identity
   * is unchanged and nothing already in a library is re-imported as a
   * duplicate of itself.
   */
  return part !== undefined && part > 1 ? `${base}?p=${part}` : base
}
