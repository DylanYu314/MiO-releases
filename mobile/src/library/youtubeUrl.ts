/**
 * Reading a YouTube video id out of whatever was pasted (#246).
 *
 * Its own module, with no dependencies, because "is this a YouTube link" is a
 * question the *search screen* asks — and importing it from `extract.ts` would
 * drag `youtubei.js` in with it. That library is ESM and 1.7 MB, so a regex
 * check would pull it into any screen that wanted one, and into any test that
 * renders such a screen.
 */

export class NotAYouTubeLink extends Error {
  constructor(input: string) {
    super(`Not a YouTube link: ${input}`)
    this.name = 'NotAYouTubeLink'
  }
}

/** The `v` parameter, or a bare id. Throws rather than guessing at a non-URL. */
export function videoIdFrom(input: string): string {
  const trimmed = input.trim()
  // A bare id: 11 characters of YouTube's alphabet.
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed

  try {
    const url = new URL(trimmed)
    const fromQuery = url.searchParams.get('v')
    if (fromQuery) return fromQuery
    // youtu.be/<id> and /shorts/<id> put it in the path.
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last && /^[\w-]{11}$/.test(last)) return last
  } catch {
    // Not a URL. Fall through to the error below rather than reporting a parse
    // failure, which tells the user nothing they can act on.
  }

  throw new NotAYouTubeLink(input)
}

/**
 * Whether this input names a YouTube video.
 *
 * Renamed from `canImportOnDevice` in #492, and the rename is the point: the
 * device can now fetch Bilibili too, so "can I import this" is no longer a
 * question about YouTube. It lives in `sources.ts` and asks both sites; this
 * one answers only for its own.
 */
export function canReadYouTubeLink(input: string): boolean {
  try {
    videoIdFrom(input)
    return true
  } catch {
    return false
  }
}
