import {
  LATEST_VERSION_URLS,
  fetchLatestVersion,
  isNewerVersion,
  parseLatestVersion,
} from '../src/updates/latestVersion'

describe('isNewerVersion', () => {
  it('sees a higher patch, minor and major', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true)
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true)
  })

  it('compares numerically, not as strings', () => {
    // The bug that lies dormant until the tenth release: "1.10.0" < "1.9.0"
    // lexicographically, because "1" sorts before "9".
    expect(isNewerVersion('1.9.0', '1.10.0')).toBe(true)
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(false)
    expect(isNewerVersion('9.0.0', '10.0.0')).toBe(true)
  })

  it('is false for the same version', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
  })

  it('treats a missing component as zero', () => {
    expect(isNewerVersion('1.1', '1.1.0')).toBe(false)
    expect(isNewerVersion('1.1.0', '1.1')).toBe(false)
    expect(isNewerVersion('1.1', '1.1.1')).toBe(true)
  })

  it('never nags a build that is ahead of the manifest', () => {
    // A development build, or a manifest that has not caught up yet.
    expect(isNewerVersion('2.0.0', '1.0.0')).toBe(false)
  })

  it('is false when either side does not parse', () => {
    expect(isNewerVersion('1.0.0', 'banana')).toBe(false)
    expect(isNewerVersion('banana', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0.0-beta')).toBe(false)
    expect(isNewerVersion('1.0.0', '')).toBe(false)
    expect(isNewerVersion('1.0.0', '1..0')).toBe(false)
    expect(isNewerVersion('1.0.0', '-1.0.0')).toBe(false)
  })
})

describe('parseLatestVersion', () => {
  const valid = { versionName: '1.1.0', url: 'https://mio.dlany.uk/MiO.apk' }

  it('accepts a well-formed manifest', () => {
    expect(parseLatestVersion(valid)).toEqual(valid)
  })

  it('keeps notes when present and omits them when not', () => {
    expect(parseLatestVersion({ ...valid, notes: 'Fixes YouTube' })).toEqual({
      ...valid,
      notes: 'Fixes YouTube',
    })
    expect(parseLatestVersion(valid)).not.toHaveProperty('notes')
  })

  it('refuses an HTML page parsed from a 200 that meant "no such file"', () => {
    // The realistic failure: Caddy's SPA fallback. `JSON.parse` usually throws
    // on HTML, but the point is that nothing about a 200 is trusted.
    expect(parseLatestVersion('<!doctype html><html></html>')).toBeNull()
    expect(parseLatestVersion(null)).toBeNull()
    expect(parseLatestVersion(undefined)).toBeNull()
    expect(parseLatestVersion(42)).toBeNull()
    expect(parseLatestVersion([])).toBeNull()
  })

  it('refuses a manifest whose version does not parse', () => {
    expect(parseLatestVersion({ ...valid, versionName: 'latest' })).toBeNull()
    expect(parseLatestVersion({ ...valid, versionName: '' })).toBeNull()
    expect(parseLatestVersion({ ...valid, versionName: 1.1 })).toBeNull()
  })

  it('refuses a url that is missing, not a string, or not https', () => {
    expect(parseLatestVersion({ versionName: '1.1.0' })).toBeNull()
    expect(parseLatestVersion({ ...valid, url: 42 })).toBeNull()
    expect(parseLatestVersion({ ...valid, url: 'http://mio.dlany.uk/MiO.apk' })).toBeNull()
  })

  it('refuses notes that are not a string', () => {
    expect(parseLatestVersion({ ...valid, notes: 42 })).toBeNull()
  })
})

describe('fetchLatestVersion', () => {
  const valid = { versionName: '1.1.0', url: 'https://mio.dlany.uk/MiO.apk' }

  const respond = (body: unknown, ok = true) =>
    jest.fn().mockResolvedValue({ ok, json: async () => body } as unknown as Response)

  it('returns the manifest when the server answers properly', async () => {
    await expect(fetchLatestVersion('https://x/version.json', respond(valid))).resolves.toEqual(
      valid,
    )
  })

  it('requests the url it was given', async () => {
    const impl = respond(valid)
    await fetchLatestVersion('https://x/version.json', impl)
    expect(impl).toHaveBeenCalledWith('https://x/version.json', expect.anything())
  })

  it('returns null when the body is HTML rather than JSON', async () => {
    const impl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    } as unknown as Response)
    await expect(fetchLatestVersion('https://x/version.json', impl)).resolves.toBeNull()
  })

  it('returns null on a non-ok response', async () => {
    await expect(
      fetchLatestVersion('https://x/version.json', respond(valid, false)),
    ).resolves.toBeNull()
  })

  it('returns null — never throws — when the network is gone', async () => {
    const impl = jest.fn().mockRejectedValue(new TypeError('Network request failed'))
    await expect(fetchLatestVersion('https://x/version.json', impl)).resolves.toBeNull()
  })

  it('returns null when the body is valid JSON of the wrong shape', async () => {
    await expect(
      fetchLatestVersion('https://x/version.json', respond({ tag_name: 'v1.1.0' })),
    ).resolves.toBeNull()
  })
})

describe('falling back across hosts (#725)', () => {
  const valid = { versionName: '1.1.0', url: 'https://dl.dlany.uk/MiO-v1.1.0.apk' }

  /** A fetch that answers per-URL, so order is observable rather than assumed. */
  const routed = (answers: Record<string, unknown | 'network-error' | 'html'>) =>
    jest.fn().mockImplementation((url: string) => {
      const answer = answers[url]
      if (answer === undefined) throw new Error(`test did not expect a request to ${url}`)
      if (answer === 'network-error') return Promise.reject(new TypeError('Network request failed'))
      if (answer === 'html') {
        return Promise.resolve({
          ok: true,
          json: async () => {
            throw new SyntaxError('Unexpected token <')
          },
        } as unknown as Response)
      }
      return Promise.resolve({ ok: true, json: async () => answer } as unknown as Response)
    })

  const [PRIMARY, FALLBACK, LAST] = LATEST_VERSION_URLS

  it("asks the bucket's r2.dev host first, the only one China can reach", () => {
    /*
     * ⛔ Order is the whole point, not an implementation detail.
     *
     * ⚠️ **This test used to assert `dl.dlany.uk` first, for a reason that was
     * measured false on 2026-09-08**: the whole `dlany.uk` zone is filtered from
     * mainland China (an SNI reset, not a blocked IP — a subdomain created
     * minutes earlier was refused on first contact). `raw.githubusercontent.com`
     * is blocked there too, so *both* of the old entries were dead and a Chinese
     * user was told about no update and offered no APK.
     *
     * The bucket's own `r2.dev` hostname is measured reachable from China, on
     * the same Cloudflare `104.16.0.0/13` as `u.expo.dev`, which also works
     * there. So it goes first — and #725's shape is the reason this is asserted
     * on the *list* rather than on behaviour: every test below passes on any
     * order, so a reordering would otherwise be invisible.
     */
    expect(PRIMARY).toContain('r2.dev')
    expect(FALLBACK).toContain('dl.dlany.uk')
    expect(LAST).toContain('raw.githubusercontent.com')
    expect(LATEST_VERSION_URLS).toHaveLength(3)
  })

  it('stops at the first host that answers, and never asks the second', async () => {
    const impl = routed({ [PRIMARY]: valid })
    await expect(fetchLatestVersion(LATEST_VERSION_URLS, impl)).resolves.toEqual(valid)
    // The control: `routed` throws on an unexpected URL, so a request to the
    // fallback would fail the test rather than pass silently.
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('falls through to the next host when the first is unreachable', async () => {
    const impl = routed({ [PRIMARY]: 'network-error', [FALLBACK]: valid })
    await expect(fetchLatestVersion(LATEST_VERSION_URLS, impl)).resolves.toEqual(valid)
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('reaches GitHub when both Cloudflare hosts fail', async () => {
    // What a mainland-China client would do if the r2.dev host were ever
    // filtered too: two resets, then the archive.
    const impl = routed({
      [PRIMARY]: 'network-error',
      [FALLBACK]: 'network-error',
      [LAST]: valid,
    })
    await expect(fetchLatestVersion(LATEST_VERSION_URLS, impl)).resolves.toEqual(valid)
    expect(impl).toHaveBeenCalledTimes(3)
  })

  it('falls through on a 200 that is not a manifest, not just on a failure', async () => {
    /*
     * ⚠️ The case a status-code check would miss. A missing object answers with
     * an HTML error page, and Caddy's SPA fallback answers 200 with the whole
     * app — both are "successful" responses carrying the wrong thing. Already
     * measured once on this project: `mio.dlany.uk/version.json` returned 200
     * and 3 KB of HTML before the file existed.
     */
    const impl = routed({ [PRIMARY]: 'html', [FALLBACK]: valid })
    await expect(fetchLatestVersion(LATEST_VERSION_URLS, impl)).resolves.toEqual(valid)
  })

  it('returns null when every host fails, rather than throwing', async () => {
    const impl = routed({
      [PRIMARY]: 'network-error',
      [FALLBACK]: 'network-error',
      [LAST]: 'network-error',
    })
    await expect(fetchLatestVersion(LATEST_VERSION_URLS, impl)).resolves.toBeNull()
    expect(impl).toHaveBeenCalledTimes(3)
  })
})
