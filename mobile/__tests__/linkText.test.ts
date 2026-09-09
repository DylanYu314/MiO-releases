import { linksIn, linkToImport } from '../src/library/linkText'
import { canImportOnDevice } from '../src/library/sources'

/**
 * Reading the link out of what a share sheet actually hands over (#573).
 *
 * Nothing shares a bare URL. Add-link validates with `platformOf`, which starts
 * at `new URL(input)`, so every one of these was refused and the user had to
 * edit a sentence down to a URL on a phone keyboard.
 */

describe('linksIn', () => {
  it('leaves a bare URL exactly as it is', () => {
    // The case that already worked and must keep working: this function sits in
    // front of every paste, not only the messy ones.
    expect(linksIn('https://youtu.be/dQw4w9WgXcQ')).toEqual(['https://youtu.be/dQw4w9WgXcQ'])
  })

  it('finds one in a sentence', () => {
    expect(linksIn('Check out this video https://youtu.be/dQw4w9WgXcQ')).toEqual([
      'https://youtu.be/dQw4w9WgXcQ',
    ])
  })

  it('reads what Bilibili actually shares', () => {
    // Its share text is a bracketed title and then a link with tracking
    // parameters, which must survive — `share_source` is not ours to strip and
    // removing query parameters would break links that need them.
    const shared =
      '【Show You】 https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy_web&vd_source=abc'

    expect(linksIn(shared)).toEqual([
      'https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy_web&vd_source=abc',
    ])
  })

  it.each([
    ['English full stop', 'Watch https://youtu.be/abcdefghijk.', 'https://youtu.be/abcdefghijk'],
    ['a bracket', '(https://youtu.be/abcdefghijk)', 'https://youtu.be/abcdefghijk'],
    [
      'Chinese punctuation',
      '看这个 https://youtu.be/abcdefghijk。',
      'https://youtu.be/abcdefghijk',
    ],
    ['a comma', 'https://youtu.be/abcdefghijk, and more', 'https://youtu.be/abcdefghijk'],
  ])('strips %s from the end', (_name, text, expected) => {
    expect(linksIn(text)).toEqual([expected])
  })

  it('keeps a trailing slash, which is part of the URL', () => {
    // The line the stripping must not cross: punctuation that follows a link in
    // prose goes, characters the link is made of stay.
    expect(linksIn('see https://www.bilibili.com/video/BV1xx411c7mD/')).toEqual([
      'https://www.bilibili.com/video/BV1xx411c7mD/',
    ])
  })

  it('finds several, in the order they appear', () => {
    expect(linksIn('first https://a.test/1 then https://b.test/2')).toEqual([
      'https://a.test/1',
      'https://b.test/2',
    ])
  })

  it('finds none in text that has none', () => {
    expect(linksIn('just some words')).toEqual([])
    expect(linksIn('')).toEqual([])
  })

  it('refuses what is left when the punctuation was the whole tail', () => {
    /*
     * ⚠️ The case that makes the hostname check reachable at all, and my first
     * attempt at this test did not reach it: `https:// and https://` never
     * matches the pattern, because it requires a non-space after the slashes —
     * so the mutation "a bare scheme counts as a link" survived against it.
     *
     * `https://,` *does* match, and stripping the comma leaves a scheme and
     * nothing else. `new URL` accepts that in some runtimes and rejects it in
     * others, which is the class of bug #557 came from, so this decides for
     * itself rather than trusting the platform.
     */
    expect(linksIn('nothing here https://, really')).toEqual([])
    expect(linksIn('(https://)')).toEqual([])
  })

  it('does not guess at a link with no scheme', () => {
    /*
     * ⚠️ Deliberate. `b23.tv/abc` is a real link and is also indistinguishable
     * from a sentence containing a full stop, and the cost of guessing wrong is
     * importing something nobody asked for. Bilibili's own share text carries
     * the scheme, so the common case is covered without the guessing.
     */
    expect(linksIn('shared via b23.tv/vtV4k1G')).toEqual([])
    // ⚠️ And it stays out even if the pattern were loosened to match bare
    // hosts: `new URL('b23.tv/…')` throws, so the hostname check is a second
    // and independent reason. Recorded because a mutation loosening the pattern
    // survives this file, and that is the honest reason why.
    expect(linksIn('shared via www.bilibili.com/video/BV1xx411c7mD')).toEqual([])
  })
})

describe('linkToImport', () => {
  it('prefers a link this device can actually fetch', () => {
    /*
     * Share text routinely carries more than one link — a tracking wrapper, a
     * channel page, a timestamped copy — and the first is not reliably the
     * interesting one.
     */
    const text = 'via https://example.com/tracker?to=x — https://youtu.be/dQw4w9WgXcQ'

    expect(linkToImport(text, canImportOnDevice)).toBe('https://youtu.be/dQw4w9WgXcQ')
  })

  it('falls back to the first link when none is preferred', () => {
    // So the caller can still show its own "this site needs the server" message
    // rather than getting a null it cannot explain.
    expect(linkToImport('see https://example.com/song', canImportOnDevice)).toBe(
      'https://example.com/song',
    )
  })

  it('is null when there is nothing to act on', () => {
    expect(linkToImport('no links here', canImportOnDevice)).toBeNull()
  })
})
