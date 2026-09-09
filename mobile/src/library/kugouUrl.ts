/**
 * Reading a Kugou playlist out of whatever was pasted (#104).
 *
 * Its own dependency-free module, for the same reason `neteaseUrl.ts` and
 * `qqUrl.ts` are: "is this a Kugou link" is a question a screen asks, and
 * importing it from `kugou.ts` would drag the fetcher in behind the answer.
 *
 * ## The id is always in the path
 *
 * Kugou calls a playlist a 歌单 and its id a `specialid`. Every spelling we can
 * read puts it in the path rather than a query parameter:
 *
 * - `www.kugou.com/yy/special/single/4304395.html` — the desktop site, verified
 *   to serve that playlist's contents;
 * - `www.kugou.com/special/single/4304395.html` — the same without the `/yy`;
 * - `m.kugou.com/plist/list/4304395` — the mobile site.
 *
 * There is no short-link host to resolve, so nothing here needs a network round
 * trip and the whole module stays pure.
 *
 * ## ⚠️ What is deliberately *not* here, and why
 *
 * Kugou has a second id space — `global_specialid`, spelled `gcid_<alnum>` and
 * carried on a `/songlist/gcid_…` route. It is plausibly what the Kugou app's
 * share sheet produces, which would make it the id that matters most.
 *
 * It is not implemented because **nothing about it has been measured** (#564):
 * there is no real `gcid_` to test with, Kugou is mainland-only so it cannot be
 * obtained here, and the one reference implementation hands it to
 * `mobilecdn.kugou.com` — the host whose TLS certificate does not match its
 * hostname and which Android therefore refuses outright. Accepting a `gcid_`
 * here would produce a link the app says yes to and then cannot fetch, which is
 * a worse failure than saying no.
 *
 * The bare-id path below is what covers a Kugou user in the meantime.
 */

export class NotAKugouLink extends Error {
  constructor(input: string) {
    super(`Not a Kugou playlist link: ${input}`)
    this.name = 'NotAKugouLink'
  }
}

/**
 * `kugou.com` and **any** subdomain of it (#564).
 *
 * Widened for the same reason QQ's was: an allow-list of the prefixes seen so
 * far refuses the next one, and the route below is what does the real work of
 * telling a 歌单 from a song or an album.
 */
const KUGOU_HOST = /^(?:[a-z0-9-]+\.)*kugou\.com$/i

/**
 * The routes that name a 歌单.
 *
 * `special/single/<id>` covers both the `/yy`-prefixed desktop path and the
 * bare one; `plist/list/<id>` is the mobile site. The `.html` is optional
 * because only the desktop form carries it. Matching the *route* rather than
 * hunting for digits is what stops a song or album page being read as a
 * playlist — they sit on `/song/` and `/album/` with identically shaped ids.
 */
const LIST_ROUTES = [
  /\/special\/single\/(\d+)(?:\.html)?\/?$/i,
  /\/plist\/list\/(\d+)(?:\.html)?\/?$/i,
]

const NUMERIC_ID = /^\d+$/

function urlOf(input: string): URL | null {
  try {
    return new URL(input.trim())
  } catch {
    return null
  }
}

/**
 * The playlist this input names. Throws rather than guessing.
 */
export function kugouPlaylistId(input: string): string {
  const trimmed = input.trim()

  /*
   * A bare id, which a `source_url` round-trip and a test both produce — and
   * since #564 the documented way in when no link can be obtained.
   *
   * It matters more here than for QQ: Kugou is mainland-only, so the app's share
   * format cannot be sampled from here at all. The id is the path that does not
   * depend on knowing it.
   */
  if (NUMERIC_ID.test(trimmed)) return trimmed

  const url = urlOf(trimmed)
  if (url === null || !KUGOU_HOST.test(url.hostname)) throw new NotAKugouLink(input)

  for (const route of LIST_ROUTES) {
    const match = route.exec(url.pathname)
    if (match !== null) return match[1]
  }

  throw new NotAKugouLink(input)
}

/**
 * Whether the app should treat this as a Kugou playlist at all.
 *
 * The question this answers is *which site*, not *which playlist*.
 */
export function isKugouPlaylistLink(input: string): boolean {
  try {
    kugouPlaylistId(input)
    return true
  } catch {
    return false
  }
}

/** The one URL stored as the import's `source_url`, so two spellings of one
 *  playlist are recognisably the same import. */
export function canonicalKugouPlaylistUrl(id: string): string {
  return `https://www.kugou.com/yy/special/single/${id}.html`
}
