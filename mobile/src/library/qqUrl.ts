/**
 * Reading a QQ Music playlist out of whatever was pasted (#103).
 *
 * Its own dependency-free module, for the same reason `neteaseUrl.ts` and
 * `bilibiliUrl.ts` are: "is this a QQ Music link" is a question a screen asks,
 * and importing it from `qq.ts` would drag the fetcher in behind the answer.
 *
 * ## The spellings of one playlist
 *
 * QQ Music calls a playlist a 歌单 and gives it an id it calls `disstid`. The
 * same list is reachable as:
 *
 * - `y.qq.com/n/ryqq/playlist/7707261125` — the current web player;
 * - `y.qq.com/n/ryqq_v2/playlist/7799808010` — its successor. Costs nothing,
 *   because the route below matches on the tail rather than on `ryqq`;
 * - `y.qq.com/n/yqq/playlist/7707261125.html` — the previous one, still handed
 *   out by older links;
 * - `i2.y.qq.com/n3/other/pages/details/playlist.html?id=7256920196` — **what a
 *   phone actually produces**, and the reason this module was widened (#564);
 * - `i.y.qq.com/n2/m/share/details/taoge.html?id=7707261125` — an older share
 *   page, kept because links already handed out still carry it.
 *
 * The id is in the **path** for the web routes and in a query parameter for the
 * share pages, so both are read rather than regexing digits out of the raw
 * string: a bare `?id=` on some other QQ page is not a playlist.
 *
 * ## Why the phone's link is the one that matters
 *
 * Measured 2026-08-17: the QQ Music **app** offers no "copy link" and no "open
 * in browser" — its share sheet lists other Tencent apps and nothing else. So
 * the only URL a phone user can obtain is the one that comes back out of
 * whichever app they shared into, and every one of those is a
 * `details/playlist.html` page on an `i<n>.y.qq.com` host. Refusing it made the
 * feature unreachable from a phone while working perfectly from a desktop
 * browser, which is precisely backwards for an Android app.
 *
 * ## The host is the loose part and the route is the strict part
 *
 * Any `*.y.qq.com` subdomain is accepted — `i2` today, `i3` tomorrow, and the
 * number is a load-balancing detail nobody promised to keep. What stops a song
 * or album page being read as a playlist is the **route**, not the host: an
 * `album.html?id=…` carries an identically shaped id and must be refused.
 *
 * Unlike NetEase there is no short-link host to resolve, so nothing here needs a
 * network round trip and the whole module stays pure.
 */

export class NotAQQLink extends Error {
  constructor(input: string) {
    super(`Not a QQ Music playlist link: ${input}`)
    this.name = 'NotAQQLink'
  }
}

/**
 * `y.qq.com` and **any** subdomain of it (#564).
 *
 * It used to name four prefixes and the phone's `i2.` was not among them. The
 * numbered `i<n>` hosts are load balancing, so an allow-list of the ones seen so
 * far is a list that goes stale the next time Tencent adds a machine.
 */
const QQ_HOST = /^(?:[a-z0-9-]+\.)*y\.qq\.com$/i

/** `/n/ryqq/playlist/<id>`, `/n/ryqq_v2/playlist/<id>` and
 *  `/n/yqq/playlist/<id>.html`, trailing slash and all. Matched on the tail, so
 *  a rename of the player route costs nothing. The `.html` is optional because
 *  only the older form carries it. */
const PATH_ROUTE = /\/playlist\/(\d+)(?:\.html)?\/?$/i

/**
 * The share pages, whose id is a query parameter instead.
 *
 * - `/n3/other/pages/details/playlist.html` — what a phone produces today;
 * - `/n2/m/share/details/taoge.html` — the older one, still in circulation.
 *
 * Matched on the route so that `?id=` elsewhere on the site is not mistaken for
 * a playlist. ⚠️ **`album.html` and `songDetail` carry identically shaped ids**,
 * which is the whole reason this is a route match and not a digit hunt.
 */
const SHARE_ROUTES = [/\/details\/playlist\.html$/i, /\/share\/details\/taoge\.html$/i]

/** The parameter the id arrives under. `disstid` is QQ's own name for it and
 *  appears on older share links; `id` is what the current page uses. */
const ID_PARAMS = ['id', 'disstid'] as const

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
export function qqPlaylistId(input: string): string {
  const trimmed = input.trim()

  /*
   * A bare id, which a `source_url` round-trip and a test both produce — and
   * since #564 the documented way out when no link can be obtained at all.
   *
   * It is the escape hatch that makes this module's strictness affordable: a
   * share format nobody has seen yet costs the user a copy of the digits rather
   * than a feature they cannot use.
   */
  if (NUMERIC_ID.test(trimmed)) return trimmed

  const url = urlOf(trimmed)
  if (url === null || !QQ_HOST.test(url.hostname)) throw new NotAQQLink(input)

  const inPath = PATH_ROUTE.exec(url.pathname)
  if (inPath !== null) return inPath[1]

  if (SHARE_ROUTES.some((route) => route.test(url.pathname))) {
    for (const name of ID_PARAMS) {
      const id = url.searchParams.get(name)
      if (id !== null && NUMERIC_ID.test(id)) return id
    }
  }

  throw new NotAQQLink(input)
}

/**
 * Whether the app should treat this as a QQ Music playlist at all.
 *
 * The question this answers is *which site*, not *which playlist*.
 */
export function isQQPlaylistLink(input: string): boolean {
  try {
    qqPlaylistId(input)
    return true
  } catch {
    return false
  }
}

/** The one URL stored as the import's `source_url`, so two spellings of one
 *  playlist are recognisably the same import. */
export function canonicalQQPlaylistUrl(id: string): string {
  return `https://y.qq.com/n/ryqq/playlist/${id}`
}
