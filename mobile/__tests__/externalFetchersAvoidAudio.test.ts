import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * That the app never reaches for audio on NetEase, QQ Music or Kugou
 * (ADR-013 decision 1).
 *
 * ## Why a source-reading guard, and not a code review rule
 *
 * #102's own text says the extractor "also returns a direct mp3 URL — we must
 * never touch it", and it was right: yt-dlp on a `netease:song` URL returns a
 * playable 128–320 kbps `music.126.net` URL, measured 2026-08-16. ADR-013's
 * answer was not to be disciplined about ignoring it but to **never ask** — MiO
 * calls each service's metadata endpoint, which returns no audio URL at all.
 *
 * That is a property of which endpoints the code names, so it is checkable by
 * reading the code. A prohibition nobody can enforce is not a guarantee.
 *
 * ## Directory-driven on purpose
 *
 * It scans the whole app rather than a list of fetcher files, so #103 (QQ) and
 * #104 (Kugou) inherit it wherever they land — the same argument
 * `nativeModuleConfig.test.ts` makes for reading `modules/`. A hand-written
 * list is how the second one inherits none of it.
 */

const MOBILE_ROOT = join(__dirname, '..')
const SCANNED = ['src', 'app', 'plugins', 'modules']
const EXTENSIONS = /\.(ts|tsx|js|jsx|kt|java)$/

/**
 * Hosts and endpoints that serve, or hand out, these services' own audio.
 *
 * The CDN hosts are what a stream URL points at. The endpoints are what mints
 * one — naming those is the step ADR-013 forbids, and it is the more useful
 * half of this check, because a URL only appears once a request has been made.
 */
const AUDIO_MARKERS: { name: string; pattern: RegExp }[] = [
  // NetEase: the audio CDN, and the two endpoints that resolve a stream.
  { name: 'NetEase audio CDN', pattern: /music\.126\.net/i },
  { name: 'NetEase song/url', pattern: /song\/enhance\/player\/url|\/song\/url\b/i },
  // QQ Music: the download host and the vkey endpoint that authorises it.
  { name: 'QQ Music stream host', pattern: /stream\.qqmusic\.qq\.com/i },
  { name: 'QQ Music vkey', pattern: /fcg_music_express_mobile|getvkey/i },
  // Kugou: the tracker that serves files, and the endpoint that names them.
  { name: 'Kugou tracker', pattern: /trackercdn\.kugou\.com|fs\.\w+\.kugou\.com/i },
  { name: 'Kugou getSongInfo', pattern: /app\/i\/getSongInfo|play\/getdata/i },
]

/**
 * The file with its comments removed.
 *
 * The invariant is about what the code *requests*, and a comment is exactly
 * where you would want to name the forbidden thing in order to explain why —
 * `netease.ts`'s docblock does, and the first run of this test failed on it.
 *
 * ⚠️ **Only whole-line `//` comments are stripped, never a trailing one.**
 * A naive strip at the first `//` would cut `'https://music.126.net/…'` in half
 * and hide the very thing this looks for, which would leave a test that passes
 * on the broken case — the failure mode that makes a guard worse than nothing.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    // `__tests__` is not scanned — this file names every marker it forbids, and
    // a test asserting an endpoint is absent is not the app calling it.
    if (entry === 'node_modules' || entry === '__tests__' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (EXTENSIONS.test(entry)) found.push(path)
  }
  return found
}

describe('no path in the app reaches for a Chinese platform’s audio', () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(join(MOBILE_ROOT, dir)))

  it('scans a plausible number of files, so an empty sweep cannot pass', () => {
    // A control, for the same reason #523's dex check needed one: a scan that
    // found nothing and a scan that ran on nothing look identical from the
    // outside, and only one of them is a passing test.
    expect(files.length).toBeGreaterThan(100)
  })

  it.each(AUDIO_MARKERS)('never names the $name', ({ pattern }) => {
    const offenders = files
      .filter((file) => pattern.test(code(readFileSync(file, 'utf8'))))
      .map((file) => relative(MOBILE_ROOT, file))

    expect(offenders).toEqual([])
  })

  it('would catch a marker in real code, comment-stripping and all', () => {
    // The mutation this test could not otherwise survive: if `code()` were
    // over-eager the sweep above would pass on an app that does fetch audio.
    expect(code("const url = 'https://m802.music.126.net/x.mp3' // the CDN")).toMatch(
      /music\.126\.net/,
    )
    expect(code('/** music.126.net in prose */\nconst x = 1')).not.toMatch(/music\.126\.net/)
    expect(code('// music.126.net in a line comment\nconst x = 1')).not.toMatch(/music\.126\.net/)
  })
})
