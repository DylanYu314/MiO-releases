/**
 * Is there a newer *APK* than the one running? (#665)
 *
 * ## Why this cannot be an over-the-air update
 *
 * `expo-updates` is keyed on the native fingerprint, so a build with new native
 * code is a different runtime version and the phone is never offered it. That
 * is correct behaviour — a JS bundle compiled against different native code
 * would crash — but it leaves a hole: **the user is never told the new APK
 * exists.** On 2026-08-21 the app on my phone could not have discovered
 * v1.0.0 by any means.
 *
 * ## Why a static file, and not the GitHub releases API
 *
 * The **source** repo is private, and measured 2026-08-21 its
 * `api.github.com/.../releases/latest` answers **404** unauthenticated —
 * reading it would mean shipping a token inside an APK, where anyone can read
 * it. Releases therefore live in a separate *public* repo, `MiO-releases`,
 * which holds no source.
 *
 * That repo's API *would* answer now. This still reads a plain file, because
 * unauthenticated GitHub is **60 requests/hour per IP** and phones sit behind
 * carrier NAT, so a launch-time check against the API could start being refused
 * for reasons no user could act on. A raw file has no such ceiling.
 *
 * It is also independent of Expo's update server, which is the point of a
 * backstop: if the over-the-air mechanism itself breaks, this must not break
 * with it.
 *
 * ## ⚠️ A 200 does not mean the file exists
 *
 * Caddy serves the web client with `try_files {path} /index.html`, so a request
 * for a file that is *not on disk* returns **HTTP 200 with `text/html`** — the
 * React app's index page. Measured, not assumed: before `version.json` was
 * uploaded, `https://mio.dlany.uk/version.json` answered 200 and 3 KB of HTML.
 *
 * So `response.ok` carries no information here and neither does the status code.
 * The only trustworthy signal is the **shape of the body**, which is why
 * `parseLatestVersion` validates every field rather than casting.
 *
 * ## ⚠️ Every failure is silent, by decision
 *
 * MiO ships with no server (#613, ADR-020). A version check that complained
 * when it could not reach a host would undo that — an offline user would be
 * nagged by a feature that exists to help them. Unreachable, malformed, HTML
 * instead of JSON, a version string that does not parse: all of them mean
 * "say nothing", never "show an error".
 */

/** What `version.json` is allowed to say. Anything else is treated as absent. */
export type LatestVersion = {
  /** Matches `expo.version` in `app.json`, e.g. `"1.0.0"`. */
  versionName: string
  /** Where a human goes to get it. Shown as a link, never fetched by the app. */
  url: string
  /** Optional one-liner; the banner shows it when present. */
  notes?: string
}

/**
 * Validate a parsed JSON body into a `LatestVersion`, or `null`.
 *
 * Deliberately strict. The realistic wrong answer here is not a subtly bad
 * field, it is **an entire HTML page** parsed from a 200 that meant "no such
 * file" — so the question this asks is "is this the document I expected",
 * not "can I coerce something out of it".
 */
export function parseLatestVersion(raw: unknown): LatestVersion | null {
  if (typeof raw !== 'object' || raw === null) return null

  const body = raw as Record<string, unknown>
  const { versionName, url, notes } = body

  if (typeof versionName !== 'string' || parseVersion(versionName) === null) return null
  // Only https. An http URL in a file we serve would be a downgrade a network
  // could force, and the value is shown to the user as somewhere to go.
  if (typeof url !== 'string' || !url.startsWith('https://')) return null
  if (notes !== undefined && typeof notes !== 'string') return null

  return notes === undefined ? { versionName, url } : { versionName, url, notes }
}

/**
 * Split a dotted version into numbers, or `null` if it is not one.
 *
 * ⚠️ **Numeric, not lexicographic.** `"1.10.0"` is newer than `"1.9.0"` and a
 * string comparison says the opposite — the kind of bug that lies dormant until
 * the tenth patch release.
 */
function parseVersion(value: string): number[] | null {
  const parts = value.split('.')
  if (parts.length === 0 || parts.length > 4) return null

  const numbers: number[] = []
  for (const part of parts) {
    // `Number('')` is 0 and `Number('1x')` is NaN; both must be refused, and so
    // must a negative or fractional component.
    if (!/^\d+$/.test(part)) return null
    numbers.push(Number(part))
  }
  return numbers
}

/**
 * Is `latest` a strictly higher version than `current`?
 *
 * `false` whenever the answer is not clearly yes — equal versions, either side
 * unparseable, or a `current` ahead of `latest` (which is what a development
 * build looks like, and must not be nagged about).
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(latest)
  if (a === null || b === null) return false

  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    // A missing component is zero, so "1.1" and "1.1.0" are the same version.
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (right > left) return true
    if (right < left) return false
  }
  return false
}

/**
 * Where the manifest lives.
 *
 * Generated from the APK by `scripts/make-version-json.sh`, so it cannot claim
 * a version the artefact next to it does not have.
 *
 * ⚠️ **Deliberately a constant in TypeScript, not `expo.extra` in `app.json`.**
 * `expoConfig` is a fingerprint source (`src/library/spotifyConfig.ts` says the
 * same about its own constants), so putting this URL in `app.json` would mean
 * that changing where updates are announced requires a native build — the exact
 * situation this feature exists to rescue people from. Here it is JavaScript,
 * so moving hosts is a one-minute `eas update`.
 */
export const LATEST_VERSION_URLS = [
  /*
   * ⛔ **The bucket's own `r2.dev` hostname first, because it is the only one
   * measured to reach everybody** (2026-09-08, #725).
   *
   * `dl.dlany.uk` was first, on the reasoning that it "reaches everybody". That
   * became false: the whole **`dlany.uk` zone** is filtered from mainland China
   * — an SNI reset (`ERR_CONNECTION_RESET`), not a blocked IP, and a brand-new
   * subdomain created for the test was refused on first contact. So both
   * entries below are dead there, and a Chinese user was told about no update
   * and offered no APK.
   *
   * ⚠️ **The IP and the CDN are innocent.** `u.expo.dev` is Cloudflare, in the
   * same `104.16.0.0/13`, and works from China; so does this bucket. Only the
   * domain name is listed. Why is unknown.
   *
   * ⚠️ **This is Cloudflare's *development* URL** and it is rate-limited. It is
   * first because a tiny user base cannot approach that limit and China cannot
   * reach anything else. If the limit ever bites, reordering is JavaScript and
   * ships over the air — and `u.expo.dev` reaches China, so the fix is
   * deliverable to the people who need it.
   */
  'https://pub-6eb86219220840aa84b5dd9ecde0059c.r2.dev/version.json',
  /*
   * The same bucket under its custom domain: prettier, not rate-limited, and
   * unreachable from China.
   *
   * ⛔ `raw.githubusercontent.com` is blocked in mainland China — confirmed by a
   * user there, after a firewall-testing site reported `google.com` as reachable
   * and so failed its own control. That made this check silently useless for
   * Chinese users: they could install the app and would never be told an update
   * existed, because the only host it asked was one they cannot reach (#725).
   *
   * `dl.dlany.uk` is a Cloudflare R2 bucket, reachable from China and fast
   * everywhere else, and it is where the APK itself now lives.
   */
  'https://dl.dlany.uk/version.json',
  /*
   * GitHub stays as a fallback rather than being dropped. It is the canonical
   * release archive, and it is the one host that keeps working if the bucket is
   * ever emptied, renamed or misconfigured — which is exactly the failure the
   * first entry cannot report on its own.
   */
  'https://raw.githubusercontent.com/DylanYu314/MiO-releases/main/version.json',
] as const

/** How long to wait before giving up. A launch must never block on this. */
const TIMEOUT_MS = 5000

/**
 * Fetch and validate the manifest. Returns `null` for every failure.
 *
 * Takes its `fetch` so tests never touch the network, the same seam
 * `app/ytdlp.py` uses on the backend.
 */
/** One host. Returns `null` for every failure, including a 200 that is not a
 *  manifest. */
async function fetchFrom(url: string, fetchImpl: typeof fetch): Promise<LatestVersion | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    // Checked even though it proves little here — see the note above about
    // Caddy answering 200 for a file that does not exist. `parseLatestVersion`
    // is what actually decides.
    if (!response.ok) return null

    const body: unknown = await response.json()
    return parseLatestVersion(body)
  } catch {
    // Offline, DNS failure, timeout, or `json()` throwing on the HTML that a
    // missing file returns. All of them mean "say nothing" (#613).
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch and validate the manifest, trying each host until one answers.
 *
 * Takes its `fetch` so tests never touch the network, the same seam
 * `app/ytdlp.py` uses on the backend, and accepts a single URL so the existing
 * per-host tests still address one host at a time.
 *
 * ⚠️ **A host that returns a *200 with the wrong body* is a failure, not an
 * answer.** `parseLatestVersion` decides, not the status code — which is what
 * lets the loop fall through Caddy-style SPA fallbacks and R2's HTML 404 page
 * to the next host rather than stopping at the first thing that responds.
 *
 * ⚠️ Worst case is `TIMEOUT_MS` per host in series, so two hosts is up to ten
 * seconds. That is deliberate: this runs in the background and never blocks a
 * launch (#665), so being slow and right beats being fast and silent.
 */
export async function fetchLatestVersion(
  source: string | readonly string[] = LATEST_VERSION_URLS,
  fetchImpl: typeof fetch = fetch,
): Promise<LatestVersion | null> {
  const urls = typeof source === 'string' ? [source] : source
  for (const url of urls) {
    const found = await fetchFrom(url, fetchImpl)
    if (found) return found
  }
  return null
}
