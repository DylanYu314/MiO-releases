import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  HOST_SOURCES,
  POLICY_PATH,
  hostsTheAppCanContact,
  policyRegions,
  type ReadRepoFile,
} from '@mio/shared/privacy-policy'

/**
 * That the published privacy policy still names every host the app contacts
 * (#741).
 *
 * ⚠️ **The logic is in `shared/privacy-policy.ts` on purpose, and so is the
 * whole explanation.** `mobile.yml` ignores `frontend/**`, so this copy never
 * runs when only the policy changes; `frontend.yml` ignores `mobile/**`, so the
 * copy in the web suite never runs when only a mobile constant changes. Neither
 * file is the guard — the pair is. **Do not delete one because it looks like a
 * duplicate.**
 *
 * This is the half that matters most, because the failure #741 was filed for
 * was a **mobile** change: #739 added `dl.dlany.uk` to the update check and the
 * policy went stale in the same commit.
 */

/** The repo root, walked to rather than assumed — jest's cwd is `mobile/`. */
function repoRoot(): string {
  let dir = resolve(process.cwd())
  for (;;) {
    if (existsSync(join(dir, POLICY_PATH)) && existsSync(join(dir, 'mobile', 'app.json')))
      return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no repo root above ${process.cwd()}`)
    dir = parent
  }
}

const read: ReadRepoFile = (path) => readFileSync(join(repoRoot(), path), 'utf8')

describe('the privacy policy describes what the app does', () => {
  it('names every host the app can contact, in every language it offers', () => {
    const hosts = hostsTheAppCanContact(read)
    const regions = policyRegions(read)

    const missing: string[] = []
    for (const { host, from } of hosts) {
      for (const [language, text] of regions) {
        if (!text.includes(host)) missing.push(`${host} (${from}) is not named in ${language}`)
      }
    }

    expect(missing).toEqual([])
  })

  /*
   * The controls. Both readings above are "a string was found in a file", the
   * shape that passes vacuously when the instrument breaks: an extractor that
   * matches nothing and an app that contacts nothing are the same green tick.
   * These fail instead.
   */

  it('read a host from every declaration it claims to read', () => {
    const hosts = hostsTheAppCanContact(read)

    for (const source of HOST_SOURCES) {
      expect(hosts.filter((h) => h.from === source.label).length).toBeGreaterThanOrEqual(
        source.minimum,
      )
    }
    // The update check alone declares two, so anything smaller is a broken read.
    expect(hosts.length).toBeGreaterThanOrEqual(HOST_SOURCES.length + 1)
  })

  it('sliced a real region for every language in the picker', () => {
    const regions = policyRegions(read)

    expect(regions.has('en')).toBe(true)
    expect(regions.size).toBeGreaterThanOrEqual(2)
    for (const text of regions.values()) expect(text.length).toBeGreaterThan(1000)
  })

  it('would report a host the policy does not name', () => {
    // The negative control. "No missing hosts" is also what a comparison that
    // never ran returns, so make the comparison answer a question with a known
    // answer: a host nothing names must come back as missing everywhere.
    const regions = policyRegions(read)
    const invented = [{ host: 'example.invalid', from: 'a host nothing names' }]

    const missing: string[] = []
    for (const { host } of invented) {
      for (const [language, text] of regions) {
        if (!text.includes(host)) missing.push(language)
      }
    }

    expect(missing).toEqual([...regions.keys()])
  })
})
