import {
  AUTO_THRESHOLD,
  REVIEW_THRESHOLD,
  classify,
  scoreCandidates,
} from '../src/library/matching'

/**
 * A confident wrong answer is worse than an honest failure (#674).
 *
 * Measured 2026-08-21 on a device: a Spotify import downloaded
 * `November Rain【Guns N'Roses】枪花 动态鼓谱` — an animated **drum score** —
 * for "November Rain". It scored **0.995** and was `auto_matched`, so it never
 * reached review, and the library row read "November Rain — Guns N' Roses"
 * because title and artist come from Spotify. Only playing it revealed it.
 */

const candidate = (title: string, over: Partial<{ uploader: string; duration: number }> = {}) => ({
  url: `https://b/${encodeURIComponent(title)}`,
  title,
  uploader: over.uploader ?? 'someone',
  duration: over.duration ?? 540,
  source: 'bilibili' as const,
})

describe('candidates that announce they are not the recording', () => {
  it('no longer auto-matches the drum score that caused this', () => {
    const [best] = scoreCandidates('November Rain', "Guns N' Roses", 537, [
      candidate("November Rain【Guns N'Roses】枪花 动态鼓谱", { duration: 540 }),
    ])

    expect(best.score).toBeLessThan(AUTO_THRESHOLD)
    expect(classify(best.score)).toBe('needs_review')
  })

  it('still offers it, rather than reporting no match', () => {
    // When it is the only result, excluding it would tell the user "nothing
    // found" about a video they can see and might want. Demote, do not hide.
    const [best] = scoreCandidates('Still Got The Blues', 'Gary Moore', 349, [
      candidate('STILL GOT THE BLUES-GARY MOORE  动态鼓谱', { duration: 350 }),
    ])

    expect(best.score).toBeGreaterThanOrEqual(REVIEW_THRESHOLD)
  })

  it('ranks the real recording above the score video', () => {
    const [best] = scoreCandidates('November Rain', "Guns N' Roses", 537, [
      // Deliberately first, because Bilibili returned it first in the real case
      // and equal scores keep input order.
      candidate("November Rain【Guns N'Roses】枪花 动态鼓谱", { duration: 540 }),
      candidate("Guns N' Roses - November Rain", { uploader: "Guns N' Roses", duration: 537 }),
    ])

    expect(best.title).toBe("Guns N' Roses - November Rain")
  })

  it('does not demote a track whose own title carries the same word', () => {
    /*
     * ⚠️ The safety of the whole change. A user importing a track actually
     * called 教学 must not be penalised for matching a candidate also called
     * 教学 — the penalty is only for a marker the *candidate* introduces.
     */
    // Uploader matches the artist, so the only thing under test is the marker.
    const [best] = scoreCandidates('教学', 'somebody', 200, [
      candidate('教学', { uploader: 'somebody', duration: 200 }),
    ])
    // The control: the same shape with a marker the candidate introduces.
    const [demoted] = scoreCandidates('Some Song', 'somebody', 200, [
      candidate('Some Song 教学', { uploader: 'somebody', duration: 200 }),
    ])

    expect(classify(best.score)).toBe('auto_matched')
    expect(classify(demoted.score)).toBe('needs_review')
  })

  it('leaves an ordinary match untouched', () => {
    const [best] = scoreCandidates('Bohemian Rhapsody', 'Queen', 355, [
      candidate('Queen - Bohemian Rhapsody (Official Video)', {
        uploader: 'Queen',
        duration: 355,
      }),
    ])

    expect(classify(best.score)).toBe('auto_matched')
  })

  it.each(['吉他谱', '贝斯谱', '钢琴谱', '简谱', '教程', '翻弹', '试听'])(
    'demotes %s as well, since they are the same kind of thing',
    (marker) => {
      const [best] = scoreCandidates('Some Song', 'Some Artist', 200, [
        candidate(`Some Song ${marker}`, { duration: 200 }),
      ])

      expect(best.score).toBeLessThan(AUTO_THRESHOLD)
    },
  )

  it('does not demote a cover, which is a real performance someone may want', () => {
    // Deliberately excluded from the marker list; asserted so that adding it
    // later is a decision rather than an accident.
    const [best] = scoreCandidates('Hallelujah', 'Leonard Cohen', 200, [
      candidate('Hallelujah (cover)', { duration: 200 }),
    ])

    expect(classify(best.score)).toBe('auto_matched')
  })
})
