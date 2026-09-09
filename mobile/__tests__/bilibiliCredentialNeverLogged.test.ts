import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { scrub } from '../src/diagnostics/log'

/**
 * A Bilibili `SESSDATA` must never reach the diagnostics log (#492, slice 3).
 *
 * ## Why this is its own file
 *
 * `docs/bilibili.md` §6.1 lists it among the non-negotiables and says exactly
 * why it gets a test rather than a sentence: **the same invariant was already
 * written down twice** — in `models.py` and in `api/clientErrors.ts` — and song
 * titles and source URLs were uploaded daily for weeks regardless, until #354
 * replaced the prose with `scrub()` and `routeOf()`.
 *
 * A credential is a worse version of that leak. The log is uploaded **once a
 * day, by design**, and `SESSDATA` *is* the account: no scope, no per-app
 * revocation, and it can post, comment, DM and read purchase history. There is
 * no version of "it probably never gets logged" that is worth relying on.
 *
 * ## What is checked
 *
 * The filter, and the two properties of the code around it that make the filter
 * the only thing standing between a credential and an upload.
 */

const SRC = join(__dirname, '..', 'src')
const read = (...parts: string[]) => readFileSync(join(SRC, ...parts), 'utf8')

describe('scrub', () => {
  it('redacts a session cookie in a header, which is not a URL', () => {
    // The shape `bilibiliFetch` builds. The URL rule cannot see this one.
    expect(scrub('Cookie: buvid3=abcinfoc; SESSDATA=aa%2Cbb%2Ccc')).toBe(
      'Cookie: buvid3=abcinfoc; SESSDATA=<redacted>',
    )
  })

  it('redacts the write token too, even though it is never stored', () => {
    // Not stored by us — but it arrives in the login hand-off, and an error
    // that stringifies that response would otherwise carry it.
    expect(scrub('bili_jct=secret&DedeUserID=1')).toBe('bili_jct=<redacted>&DedeUserID=1')
  })

  it('hides one inside a link, via the URL rule', () => {
    expect(scrub('failed for https://passport.bilibili.com/x?SESSDATA=aa')).toBe('failed for <url>')
  })

  it('leaves an ordinary detail alone', () => {
    // The filter must not make every log line unreadable to buy this.
    expect(scrub('mono.refused no_processor')).toBe('mono.refused no_processor')
    expect(scrub('queue.mount open=2 toCommit=475ms')).toBe('queue.mount open=2 toCommit=475ms')
  })

  it('is null-safe, because most callers pass an optional detail', () => {
    expect(scrub(null)).toBeNull()
    expect(scrub(undefined)).toBeNull()
  })
})

describe('the code around it', () => {
  /*
   * The auth module holds the credential in memory and writes it to
   * SecureStore. If it also logged, the filter would be the only thing between
   * a credential and a daily upload — and a filter is a net, not a policy.
   */
  it('the auth module logs nothing at all', () => {
    const source = read('library', 'bilibiliAuth.ts')

    expect(source).not.toMatch(/\blogInfo\(|\blogWarn\(|\blogError\(|console\./)
  })

  /*
   * One place builds the cookie header, so a private read and a public one
   * cannot drift into different request shapes — and so there is exactly one
   * line that could ever be logged by accident.
   */
  it('only one place puts the credential into a request', () => {
    const source = read('library', 'bilibili.ts')

    expect(source.match(/SESSDATA=/g) ?? []).toHaveLength(1)
    expect(source).toContain('function cookieHeader(')
  })
})
