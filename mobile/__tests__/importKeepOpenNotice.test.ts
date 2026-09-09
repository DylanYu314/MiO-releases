import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The keep-open warning has to *look* like a warning (#450).
 *
 * The text has been on the import screen since #371 was de-scoped, and I
 * still reported *"no prompt or notice to user to let them know don't quit the
 * app while importing"*. He was not missing it through carelessness: it was
 * `styles.meta` — 13px, `textMuted` — which is character-for-character the style
 * of the progress lines directly above and below it. Something that reads
 * exactly like status **is** status, however it is worded.
 *
 * ## Why this reads the source
 *
 * The notice only exists while a handover is in flight, and every fetch fake in
 * `youtubeImport.test.tsx` answers `/matches` with an empty page — so no test
 * there reaches that state at all. Reproducing it costs more than it proves,
 * and what actually regressed here is not behaviour but *register*: the same
 * words in the same style as everything around them.
 *
 * So the assertions are about the styling being distinct, which is the defect.
 * **Comments are stripped first** — #303 shipped a source-reading guard that
 * passed against broken code because the word survived in its own docblock.
 */

const source = readFileSync(
  join(__dirname, '..', 'app', '(tabs)', 'add', 'import', '[id].tsx'),
  'utf8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\/.*$/gm, '')

describe('the keep-open warning', () => {
  it('is announced as an alert rather than as more text', () => {
    expect(source).toMatch(/accessibilityRole="alert"/)
  })

  it('is not drawn with the status style it was lost in', () => {
    // The exact line that shipped, and the whole of the bug.
    expect(source).not.toMatch(/style=\{styles\.meta\}>\{t\('importDetail\.keepScreenOpen'\)\}/)
    expect(source).toMatch(/styles\.noticeText[\s\S]*importDetail\.keepScreenOpen/)
  })

  it('has a surface and a rule, which is what carries it at a glance', () => {
    const notice = /notice:\s*\{[\s\S]*?\},/.exec(source)?.[0] ?? ''
    expect(notice).toMatch(/backgroundColor:/)
    expect(notice).toMatch(/borderLeftWidth:\s*[1-9]/)
  })

  it('uses body text, not the muted register it was lost in', () => {
    const noticeText = /noticeText:\s*\{[^}]*\}/.exec(source)?.[0] ?? ''
    expect(noticeText).toMatch(/color:\s*theme\.text\b/)
    expect(noticeText).not.toMatch(/textMuted/)
  })

  /**
   * Where it is, which is what #450 did not fix (#458).
   *
   * #450 made it *look* like a warning and left it at the bottom of the screen,
   * under a track list that was 136 rows on the import I was running. A
   * warning reached by scrolling is read after the mistake it exists to prevent
   * — so position is part of the defect, not a separate nicety, and only a
   * position assertion can catch it coming back.
   */
  describe('and where it is', () => {
    const at = (pattern: RegExp) => source.search(pattern)

    it('comes before the track list, not after it', () => {
      const notice = at(/importDetail\.keepScreenOpen/)
      const list = at(/<MatchReview/)
      expect(notice).toBeGreaterThan(-1)
      expect(list).toBeGreaterThan(-1)
      expect(notice).toBeLessThan(list)
    })

    it('comes before the download bar the user is already watching', () => {
      // The **download** bar specifically. There are two `styles.fill` bars on
      // this screen and the matching one is above both — asserting on the first
      // match would pass on any arrangement and prove nothing.
      const downloadBar = at(/isDownloading \|\| data\.status === 'done'/)
      expect(downloadBar).toBeGreaterThan(-1)
      expect(at(/importDetail\.keepScreenOpen/)).toBeLessThan(downloadBar)
    })

    it('is still shown only while a run is actually going', () => {
      // A warning that is always on screen is furniture within a day, so the
      // move must not have cost it its condition.
      const guarded = /\{isDownloading \?[\s\S]{0,400}?importDetail\.keepScreenOpen/
      expect(source).toMatch(guarded)
    })
  })
})
