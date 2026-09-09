/**
 * Reading a Bilibili **favourites folder** out of whatever was pasted (#492).
 *
 * Its own module with no dependencies, for the same reason `bilibiliUrl.ts` is
 * one: "is this a favourites link" is a question a screen asks, and importing it
 * from `bilibiliFav.ts` would drag the whole reader into any screen that wanted
 * the answer.
 *
 * ## The id is the `media_id`, and it has three spellings
 *
 * A folder is addressed by a numeric `media_id`. Bilibili spells it three ways
 * in links people actually copy:
 *
 *     space.bilibili.com/<mid>/favlist?fid=<media_id>     the folder page
 *     space.bilibili.com/<mid>/lists/<media_id>           the newer layout
 *     bilibili.com/medialist/detail/ml<media_id>          the share link
 *
 * The `mid` in the first two is the *owner*, not the folder, and it is not
 * needed — `x/v3/fav/resource/list` takes only the `media_id`. It is deliberately
 * discarded rather than carried around as something that looks meaningful.
 *
 * ⚠️ **`?fid=` is not `?fid` alone.** The same page also takes `ftype=create`
 * and a `spm_id_from` tracking parameter, and an `fid` can appear on a
 * *collection* URL where it means something else — hence `type=season` being
 * refused below rather than silently read as a favourites folder.
 */

export class NotABilibiliFavList extends Error {
  constructor(input: string) {
    super(`Not a Bilibili favourites list: ${input}`)
    this.name = 'NotABilibiliFavList'
  }
}

const SPACE_HOST = /^(?:www\.|m\.)?space\.bilibili\.com$/i
const MAIN_HOST = /^(?:www\.|m\.)?bilibili\.com$/i

/** `ml` then digits — the share link's spelling of a media id. */
const ML_ID = /^ml(\d+)$/i
const DIGITS = /^\d+$/

function hostOf(input: string): string | null {
  try {
    return new URL(input.trim()).hostname
  } catch {
    return null
  }
}

/**
 * The `media_id` this input names. Throws rather than guessing.
 *
 * Returns a string rather than a number: these are large ids that only ever
 * travel back out as a query parameter, and `Number` on a 15-digit id is a
 * silent precision bug waiting for a bigger one.
 */
export function favIdFrom(input: string): string {
  const trimmed = input.trim()

  // A bare id, which is what a round-trip through the database produces.
  if (DIGITS.test(trimmed)) return trimmed
  const bareMl = ML_ID.exec(trimmed)
  if (bareMl) return bareMl[1]

  const host = hostOf(trimmed)
  if (host === null) throw new NotABilibiliFavList(input)

  const url = new URL(trimmed)

  if (MAIN_HOST.test(host)) {
    // /medialist/detail/ml3409179931
    const segments = url.pathname.split('/')
    if (segments.includes('medialist')) {
      for (const segment of segments) {
        const ml = ML_ID.exec(segment)
        if (ml) return ml[1]
      }
    }
    throw new NotABilibiliFavList(input)
  }

  if (!SPACE_HOST.test(host)) throw new NotABilibiliFavList(input)

  // A collection or series is a different thing with a different endpoint, and
  // it shares this path. Refuse it here rather than fetching a folder that does
  // not exist and reporting whatever Bilibili says about it.
  const type = url.searchParams.get('type')
  if (type !== null && type !== 'create') throw new NotABilibiliFavList(input)

  // /<mid>/favlist?fid=486002245
  const fid = url.searchParams.get('fid')
  if (fid && DIGITS.test(fid)) return fid

  // /<mid>/lists/486002245
  const segments = url.pathname.split('/')
  const listsAt = segments.indexOf('lists')
  if (listsAt !== -1) {
    const next = segments[listsAt + 1]
    if (next && DIGITS.test(next)) return next
  }

  throw new NotABilibiliFavList(input)
}

/** Whether a screen should offer to import this as a favourites folder. */
export function isBilibiliFavList(input: string): boolean {
  try {
    favIdFrom(input)
    return true
  } catch {
    return false
  }
}

/** The one URL the library stores for a folder, so re-importing finds the row
 *  already here rather than building a second copy. */
export function canonicalFavUrlFor(mediaId: string): string {
  return `https://www.bilibili.com/medialist/detail/ml${mediaId}`
}
