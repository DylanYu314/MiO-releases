/**
 * Reading a NetEase Cloud Music playlist out of whatever was pasted (#102).
 *
 * Its own dependency-free module for the same reason `bilibiliUrl.ts` and
 * `youtubeUrl.ts` are: "is this a NetEase link" is a question a screen asks, and
 * importing it from `netease.ts` would drag the fetcher in behind the answer.
 *
 * ## The id lives in a hash, which `URL` will not parse
 *
 * NetEase's canonical web link is `music.163.com/#/playlist?id=79177352` — the
 * whole route is inside the fragment, so `new URL(...).searchParams` sees
 * nothing at all. The `#/` is folded into the path before parsing rather than
 * regexing the id out of the raw string, so that the *route* is checked too: a
 * bare `?id=` on some other page is not a playlist.
 */

export class NotANeteaseLink extends Error {
  constructor(input: string) {
    super(`Not a NetEase playlist link: ${input}`)
    this.name = 'NotANeteaseLink'
  }
}

/** `music.163.com`, plus the `y.` and `m.` hosts its app and mobile site use. */
const MAIN_HOST = /^(?:www\.|y\.|m\.)?music\.163\.com$/i

/** `163cn.tv/xxxx` — what the NetEase app's share sheet produces. A redirect,
 *  so it carries no id and cannot be read without a request. */
const SHORT_HOST = /^(?:www\.)?163cn\.tv$/i

/** The two routes that name a track list. `playlist` is a user's list;
 *  `discover/toplist` is one of NetEase's charts, which reads identically. */
const LIST_ROUTE = /(?:^|\/)(?:playlist|toplist)$/i

const NUMERIC_ID = /^\d+$/

function urlOf(input: string): URL | null {
  try {
    // Fold the SPA fragment into the path: `/#/playlist?id=1` → `/playlist?id=1`.
    return new URL(input.trim().replace('/#/', '/'))
  } catch {
    return null
  }
}

/**
 * Whether this has to be resolved before anything can be read from it.
 *
 * A short link is still a NetEase link — {@link isNeteasePlaylistLink} says
 * yes — but it carries no id, so {@link neteasePlaylistId} refuses it and the
 * fetcher follows it first.
 */
export function isNeteaseShortLink(input: string): boolean {
  const url = urlOf(input)
  return url !== null && SHORT_HOST.test(url.hostname)
}

/**
 * The playlist this input names. Throws rather than guessing.
 *
 * Refuses a short link deliberately: there is no id in one, and answering with
 * something plausible would be worse than saying so.
 */
export function neteasePlaylistId(input: string): string {
  const trimmed = input.trim()

  // A bare id, which is what a `source_url` round-trip and a test both produce.
  if (NUMERIC_ID.test(trimmed)) return trimmed

  const url = urlOf(trimmed)
  if (url === null || !MAIN_HOST.test(url.hostname)) throw new NotANeteaseLink(input)
  // `/playlist`, `/m/playlist`, `/discover/toplist` — trailing slash and all.
  if (!LIST_ROUTE.test(url.pathname.replace(/\/+$/, ''))) throw new NotANeteaseLink(input)

  const id = url.searchParams.get('id')
  if (id === null || !NUMERIC_ID.test(id)) throw new NotANeteaseLink(input)
  return id
}

/**
 * Whether the app should treat this as a NetEase playlist at all.
 *
 * True for a short link, which has no id yet. The question this answers is
 * *which site*, not *which playlist*.
 */
export function isNeteasePlaylistLink(input: string): boolean {
  if (isNeteaseShortLink(input)) return true
  try {
    neteasePlaylistId(input)
    return true
  } catch {
    return false
  }
}

/** The one URL stored as the import's `source_url`, so two spellings of one
 *  playlist are recognisably the same import. */
export function canonicalPlaylistUrl(id: string): string {
  return `https://music.163.com/#/playlist?id=${id}`
}
