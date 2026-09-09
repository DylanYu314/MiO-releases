import { describe, expect, it } from 'vitest'

import {
  HOST_SOURCES,
  POLICY_PATH,
  hostsTheAppCanContact,
  policyRegions,
  type ReadRepoFile,
} from '@mio/shared/privacy-policy'

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * That the published privacy policy still names every host the app contacts
 * (#741).
 *
 * ⚠️ **This is not a duplicate of
 * `mobile/__tests__/privacyPolicyDescribesTheApp.test.ts`, and deleting either
 * one silently halves the guard.** The two suites have opposite blind spots:
 * `mobile.yml` lists `frontend/**` in `paths-ignore`, so the mobile copy does
 * not run when only this page changes; `frontend.yml` lists `mobile/**`, so
 * this copy does not run when only a mobile constant changes.
 *
 * This is the copy that watches **the page**. The realistic regression it
 * catches is an eighth language added to the picker whose block omits a host —
 * a frontend-only change `mobile.yml` would skip entirely. The shared logic and
 * the full reasoning live in `shared/privacy-policy.ts`.
 */

/** The repo root, walked to rather than assumed — vitest's cwd is `frontend/`. */
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
    The controls. The assertion above is "a string was found in a file", which is
    the shape that passes vacuously when the instrument breaks — an extractor
    that matches nothing and an app that contacts nothing produce the same green
    tick. These fail instead.
  */

  it('read a host from every declaration it claims to read', () => {
    const hosts = hostsTheAppCanContact(read)

    for (const source of HOST_SOURCES) {
      expect(hosts.filter((h) => h.from === source.label).length).toBeGreaterThanOrEqual(
        source.minimum,
      )
    }
    expect(hosts.length).toBeGreaterThanOrEqual(HOST_SOURCES.length + 1)
  })

  it('sliced a real region for every language in the picker', () => {
    const regions = policyRegions(read)

    expect(regions.has('en')).toBe(true)
    expect(regions.size).toBeGreaterThanOrEqual(2)
    for (const text of regions.values()) expect(text.length).toBeGreaterThan(1000)
  })

  it('would report a host the policy does not name', () => {
    // The negative control. "Nothing missing" is also what a comparison that
    // never ran returns, so ask it a question whose answer is known: a host
    // nothing names must come back missing from every language.
    const regions = policyRegions(read)

    const missing: string[] = []
    for (const [language, text] of regions) {
      if (!text.includes('example.invalid')) missing.push(language)
    }

    expect(missing).toEqual([...regions.keys()])
  })
})
