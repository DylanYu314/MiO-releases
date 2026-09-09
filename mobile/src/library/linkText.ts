/**
 * Finding the link inside whatever was pasted (#573).
 *
 * ## Why this exists
 *
 * Nothing shares a bare URL. Every share sheet, every chat app and every
 * "copy link" button on a phone hands over a *sentence*:
 *
 *     Check out this video https://youtu.be/dQw4w9WgXcQ
 *     【标题】 https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy_web
 *
 * Add-link validates with `platformOf`, which starts at `new URL(input)` — so
 * every one of those was refused, and the user had to edit the text down to the
 * URL by hand on a phone keyboard. That is the flow #573 is about, and it turns
 * out to be worth fixing on its own: it is the same problem whether the text
 * arrives through Android's share sheet or through a long-press paste.
 *
 * ## What it deliberately does not do
 *
 * **It requires a scheme.** `b23.tv/abc` and `youtu.be/abc` without `https://`
 * are perfectly real links and are also indistinguishable from ordinary prose
 * containing a full stop — and the cost of guessing wrong is an import of
 * something nobody asked for. Bilibili's own share text carries the scheme, so
 * the common case is covered without the guessing.
 *
 * It also does not fetch anything. Deciding *which* of several links to use is
 * the caller's, because only the caller knows what it can import.
 */

/**
 * Characters that routinely follow a URL in prose and are never part of it.
 *
 * The closing brackets are the interesting half: `(https://x)` is common in
 * English and `【…】https://x` in Chinese share text. A trailing `)` is stripped
 * unconditionally rather than balanced — a URL containing brackets is rare, and
 * one *ending* in an unbalanced bracket rarer still, so the simple rule is
 * right far more often than the clever one.
 */
const TRAILING = /[)\]}>,.!?;:'"、。，！？；：）】》]+$/

/** A run of non-space starting at a scheme. The scheme is required — see the
 *  module note on why guessing at bare hosts is not worth it. */
const CANDIDATE = /https?:\/\/[^\s<>"'）】]+/gi

/**
 * Every link in this text, in the order they appear.
 *
 * Returns the input itself as the only entry when it is already a bare URL, so
 * a caller never has to ask which kind of string it is holding.
 */
export function linksIn(text: string): string[] {
  const found = text.match(CANDIDATE) ?? []
  return found
    .map((link) => link.replace(TRAILING, ''))
    .filter((link) => {
      // A scheme and nothing else is not a link. `new URL` accepts `https://`
      // in some runtimes and rejects it in others, and disagreeing runtimes is
      // exactly the class of bug #557 came from — so this decides for itself.
      try {
        return new URL(link).hostname.length > 0
      } catch {
        return false
      }
    })
}

/**
 * The one link worth acting on, or null.
 *
 * `prefer` is asked first and, when it accepts one, that one wins wherever it
 * sits in the text. Share text routinely carries more than one link — a
 * tracking wrapper, a channel, a timestamped copy — and the first is not
 * reliably the interesting one.
 *
 * With nothing preferred it falls back to the first link, so a caller that
 * cannot express a preference still gets an answer rather than nothing.
 */
export function linkToImport(text: string, prefer: (link: string) => boolean): string | null {
  const links = linksIn(text)
  return links.find(prefer) ?? links[0] ?? null
}
