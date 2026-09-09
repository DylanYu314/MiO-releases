/**
 * Scoring for playlist-import track matching, on the device.
 *
 * A port of `backend/app/matching.py` (#609). Pure functions, no I/O.
 *
 * ## Why this exists twice
 *
 * #353 split matching deliberately — the phone searched, the server scored —
 * *"because one matcher cannot drift from itself"*. #608 removes the server
 * from the product, so that argument no longer holds and the reasoning is
 * replaced by a **mechanism**: `shared/matching-golden.json` is a corpus scored
 * by Python, and both suites assert against it. `shared/` is in no workflow's
 * `paths-ignore`, so a change to it runs backend *and* mobile CI.
 *
 * ⚠️ **Do not "improve" a number in here.** Every constant is duplicated from
 * `matching.py` and pinned by the golden fixture; changing one on this side
 * alone fails both suites, which is the point.
 */

import CASE_FOLD from '@mio/shared/case-fold.json'

import { logWarn } from '../diagnostics/log'

/** Confidence ≥ this is pre-accepted. */
export const AUTO_THRESHOLD = 0.8
/** Below this counts as no usable match; between the two, a human looks. */
export const REVIEW_THRESHOLD = 0.55
/** How many search results to score and keep per track. */
export const CANDIDATE_LIMIT = 5

const TITLE_WEIGHT = 0.55
const ARTIST_WEIGHT = 0.3
const DURATION_WEIGHT = 0.15

/**
 * "<Artist> - Topic" channels are YouTube's auto-generated exact album audio —
 * worth a nudge over lookalike uploads, never enough to flip a bad match.
 *
 * ⚠️ Gated on the **source**, not only the name (#551/#552, ADR-013 decision 4):
 * no Bilibili uploader can earn it, so a Bilibili user who happens to be called
 * "X - Topic" must not collect a bonus that means nothing.
 */
const TOPIC_BONUS = 0.05
const TOPIC_SOURCE = 'youtube'

/**
 * How much a candidate loses for announcing that it is not the recording (#674).
 *
 * ## Why this is needed at all
 *
 * `tokenSetRatio` returns a **perfect** score whenever one side's tokens are a
 * subset of the other's — that is deliberate, and it is what lets
 * `"Guns N' Roses - November Rain (Official Video)"` match `"November Rain"`.
 * The cost is that *any* extra words are free: measured 2026-08-21,
 * `"November Rain【Guns N'Roses】枪花 动态鼓谱"` — an animated **drum score**,
 * not the song — scored **0.995** and classified `auto_matched`, so it was
 * downloaded without ever reaching the review step. The library row then read
 * "November Rain — Guns N' Roses", because title and artist come from Spotify,
 * and only playing it revealed the audio was wrong.
 *
 * ## Why 0.25, and why demote rather than exclude
 *
 * 0.25 takes a perfect 1.0 to 0.75 — below `AUTO_THRESHOLD` (0.8) and above
 * `REVIEW_THRESHOLD` (0.55). So such a candidate can never be accepted silently,
 * and is still *offered* with its title visible for a human to judge. Excluding
 * it outright would be worse when it is the only result: the user would be told
 * "no match" about a video they might actually want.
 */
const NON_RECORDING_PENALTY = 0.25

/**
 * Titles that say "this is not the recording".
 *
 * ⚠️ **Matched as substrings, not tokens.** Chinese does not use spaces, so
 * `normalize()` leaves `动态鼓谱` as a single token and token comparison would
 * never see `鼓谱` inside it.
 *
 * ⚠️ **Deliberately narrow.** Every entry here must mean "not the recording"
 * on its own. `伴奏` (backing track) and `cover` were considered and left out:
 * a cover is a real performance somebody may want, and a false demotion is the
 * same silent failure as a false promotion, in the other direction.
 */
const NON_RECORDING_MARKERS = [
  '鼓谱', // drum score — the one that caused #674
  '吉他谱', // guitar tab
  '贝斯谱', // bass tab
  '钢琴谱', // piano score
  '简谱', // numbered notation
  '教学', // tutorial
  '教程', // tutorial
  '翻弹', // instrument re-performance
  '试听', // preview clip
]

const DURATION_FULL_CREDIT_S = 2.0
const DURATION_ZERO_CREDIT_S = 30.0

/** Release furniture, not song identity. A bracketed run made only of these
 *  (plus bare numbers, e.g. remaster years) is dropped. */
const NOISE_WORDS = new Set([
  'official',
  'video',
  'lyric',
  'lyrics',
  'audio',
  'visualizer',
  'visualiser',
  'mv',
  'hd',
  'hq',
  '4k',
  '8k',
  'music',
  'remaster',
  'remastered',
])

const BRACKETED = /[([][^)\]]*[)\]]/g
const FEAT_CLAUSE = /\b(?:feat|ft|featuring)\b\.?[^)\]]*/g
const TOPIC_SUFFIX = /\s*-\s*topic\s*$/
/**
 * ⚠️ **Not `[^\w\s]`.** JavaScript's `\w` is ASCII-only, while Python's is
 * Unicode-aware, so the naive translation would strip every CJK character and
 * silently destroy matching for the three Chinese sources. `\p{L}\p{N}_` is the
 * Unicode-property equivalent and needs the `u` flag.
 */
const PUNCTUATION = /[^\p{L}\p{N}_\s]/gu
const WHITESPACE = /\s+/g
/** Python strips characters with a non-zero combining class after NFD. */
const COMBINING = /\p{M}/gu
/** Python's `str.isdigit()`, near enough for bracket noise: Unicode digits. */
const ALL_DIGITS = /^\p{Nd}+$/u

export interface ScorableResult {
  url: string
  title: string
  uploader: string | null
  duration: number | null
  thumbnail?: string | null
  /** Which platform produced this candidate. Defaulted to YouTube to match
   *  `app/ytdlp.py`'s `SearchResult`, and because a *missing* source must never
   *  silently earn the Topic bonus. */
  source?: string
}

export interface ScoredCandidate {
  url: string
  title: string
  uploader: string | null
  duration: number | null
  score: number
  thumbnail: string | null
  source: string
}

/** The subset of `TrackMatchStatus` this scorer can produce. Lower-case, which
 *  is the *wire* spelling the API uses — the backend's DB stores the enum NAME
 *  in upper case, which is a different thing (see #610). */
export type InitialMatchStatus = 'auto_matched' | 'needs_review' | 'no_match'

let warnedNoNormalize = false

/**
 * `String.prototype.normalize`, if this runtime has it.
 *
 * ✅ **Measured present on Hermes, 2026-08-19** (versionCode 24, RMX3301):
 * `runtime.capabilities` reported `normalize=true`. So this folds exactly as
 * `matching.py` does, and the golden fixture's guarantee reaches the device.
 *
 * The guard stays. Node (and therefore jest) always has `normalize`, so no test
 * here can ever tell us — the same trap as `TextDecoder` in `audioTags.ts` and
 * `Intl.PluralRules` in #557 — and one measurement on one Hermes version is not
 * a promise about the next. Without it, accented and full-width text folds less
 * thoroughly than the server would fold it, and the diagnostics log says so
 * once rather than the app matching quietly worse.
 */
function unicodeNormalize(text: string, form: 'NFKC' | 'NFD'): string {
  if (typeof String.prototype.normalize === 'function') return text.normalize(form)
  if (!warnedNoNormalize) {
    warnedNoNormalize = true
    logWarn('matching.noNormalize', 'runtime has no String.prototype.normalize')
  }
  return text
}

/** Exported for the guard test only. */
export function resetNormalizeWarning(): void {
  warnedNoNormalize = false
}

function dropNoiseBrackets(segment: string): string {
  const words = segment.replace(PUNCTUATION, ' ').split(WHITESPACE).filter(Boolean)
  if (words.length > 0 && words.every((w) => NOISE_WORDS.has(w) || ALL_DIGITS.test(w))) {
    return ' '
  }
  return segment
}

/**
 * Python's `str.casefold()`, which JavaScript does not have.
 *
 * ⚠️ **`toLowerCase()` is not the same function.** casefold maps ß→ss and ς→σ,
 * and leaves Cherokee capitals alone where `toLowerCase()` lowercases them —
 * 297 code points in total. `shared/case-fold.json` is generated from Python by
 * `backend/scripts/dump_matching_golden.py`, so the table cannot drift from the
 * scorer it exists to mirror.
 *
 * The golden fixture caught this on its very first run (`"Straße"` folded to
 * `"straße"` here and `"strasse"` there), which is the guard doing its job.
 */
function caseFold(text: string): string {
  const table = CASE_FOLD as Record<string, string>
  let out = ''
  for (const char of text) {
    const folded = table[char]
    out += folded !== undefined ? folded : char.toLowerCase()
  }
  return out
}

/**
 * Reduce a title/artist/uploader string to its comparable core.
 *
 * Case, diacritics, punctuation and release furniture ("(Official Video)",
 * "feat. …", a trailing " - Topic") don't make two strings different songs —
 * but meaningful qualifiers like "(Live)" do, so only brackets made purely of
 * noise words are dropped. CJK and other scripts pass through.
 */
export function normalize(text: string): string {
  let out = caseFold(unicodeNormalize(text, 'NFKC'))
  out = unicodeNormalize(out, 'NFD').replace(COMBINING, '')
  out = out.replace(BRACKETED, dropNoiseBrackets)
  out = out.replace(FEAT_CLAUSE, ' ')
  out = out.replace(TOPIC_SUFFIX, ' ')
  out = out.replace(PUNCTUATION, ' ')
  return out.replace(WHITESPACE, ' ').trim()
}

/** The search text for a track. Only the primary artist: feat-lists add noise. */
export function buildSearchQuery(title: string, artist: string): string {
  const primaryArtist = artist.split(',')[0].trim()
  return `${primaryArtist} ${title}`.trim()
}

/** Code points, not UTF-16 units — Python's `len()` counts code points, and an
 *  emoji in a title would otherwise measure two here and one there. */
function codePoints(text: string): string[] {
  return Array.from(text)
}

/**
 * Indel distance: the minimum insertions and deletions to turn one sequence
 * into the other, i.e. Levenshtein with substitution weight 2. Equivalent to
 * `len(a) + len(b) - 2 * LCS(a, b)`.
 */
function indelDistance(a: string, b: string): number {
  const x = codePoints(a)
  const y = codePoints(b)
  if (x.length === 0 || y.length === 0) return x.length + y.length

  // Rolling single row — the strings here are short, but a whole matrix over a
  // 200-track import is pointless garbage.
  let previous = new Array<number>(y.length + 1).fill(0)
  let current = new Array<number>(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i += 1) {
    current[0] = 0
    for (let j = 1; j <= y.length; j += 1) {
      current[j] =
        x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1])
    }
    const swap = previous
    previous = current
    current = swap
  }
  const lcs = previous[y.length]
  return x.length + y.length - 2 * lcs
}

function normDistance(dist: number, lensum: number): number {
  return lensum ? 100 - (100 * dist) / lensum : 100
}

/** Python sorts strings by code point; JavaScript's default sort compares
 *  UTF-16 code units, which disagree above the BMP. */
function sortByCodePoint(tokens: string[]): string[] {
  return [...tokens].sort((a, b) => {
    const x = codePoints(a)
    const y = codePoints(b)
    const n = Math.min(x.length, y.length)
    for (let i = 0; i < n; i += 1) {
      const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number)
      if (d !== 0) return d
    }
    return x.length - y.length
  })
}

/**
 * `rapidfuzz.fuzz.token_set_ratio`, ported from its pure-Python reference
 * (`rapidfuzz/fuzz_py.py`) rather than from memory.
 *
 * ⚠️ **It is not plain Levenshtein**, and substituting a generic string-distance
 * library is the single way this whole wave goes silently wrong: it compares
 * the sorted token *intersection* against each sorted *difference*, and takes
 * the best of three ratios.
 */
export function tokenSetRatio(s1: string, s2: string): number {
  const tokensA = new Set(s1.split(WHITESPACE).filter(Boolean))
  const tokensB = new Set(s2.split(WHITESPACE).filter(Boolean))
  if (tokensA.size === 0 || tokensB.size === 0) return 0

  const intersect: string[] = []
  const diffAb: string[] = []
  const diffBa: string[] = []
  for (const token of tokensA) (tokensB.has(token) ? intersect : diffAb).push(token)
  for (const token of tokensB) if (!tokensA.has(token)) diffBa.push(token)

  // One sentence is part of the other one.
  if (intersect.length > 0 && (diffAb.length === 0 || diffBa.length === 0)) return 100

  const abJoined = sortByCodePoint(diffAb).join(' ')
  const baJoined = sortByCodePoint(diffBa).join(' ')
  const abLen = codePoints(abJoined).length
  const baLen = codePoints(baJoined).length
  const sectLen = codePoints(intersect.join(' ')).length
  const gap = sectLen !== 0 ? 1 : 0
  const sectAbLen = sectLen + gap + abLen
  const sectBaLen = sectLen + gap + baLen

  const result = normDistance(indelDistance(abJoined, baJoined), sectAbLen + sectBaLen)
  // The other two ratios are 0 without a shared token.
  if (sectLen === 0) return result

  const sectAbRatio = normDistance(gap + abLen, sectLen + sectAbLen)
  const sectBaRatio = normDistance(gap + baLen, sectLen + sectBaLen)
  return Math.max(result, sectAbRatio, sectBaRatio)
}

/** Normalized-string similarity in 0..1. */
function similarity(wanted: string, candidate: string): number {
  if (!wanted || !candidate) return 0
  return tokenSetRatio(wanted, candidate) / 100
}

/**
 * 1.0 within ~2 s, fading linearly to 0.0 by ~30 s off — the cheapest strong
 * discriminator against covers, edits and sped-up versions. Unknown durations
 * stay neutral (0.5) rather than punishing the candidate.
 */
function durationScore(wantedS: number | null, candidateS: number | null): number {
  if (wantedS === null || candidateS === null) return 0.5
  const delta = Math.abs(wantedS - candidateS)
  if (delta <= DURATION_FULL_CREDIT_S) return 1
  if (delta >= DURATION_ZERO_CREDIT_S) return 0
  return 1 - (delta - DURATION_FULL_CREDIT_S) / (DURATION_ZERO_CREDIT_S - DURATION_FULL_CREDIT_S)
}

function isTopicChannel(uploader: string | null, source: string): boolean {
  if (source !== TOPIC_SOURCE) return false
  return uploader !== null && uploader.trim().toLowerCase().endsWith(' - topic')
}

/**
 * Score each search result 0..1 against the wanted track, best first.
 *
 * The artist term takes the better of comparing against the candidate's title
 * and its uploader — either may carry the artist name, depending on whether the
 * upload is "Artist - Title" on a random channel or a bare title on the
 * artist's own channel.
 */
export function scoreCandidates(
  title: string,
  artist: string,
  durationS: number | null,
  results: readonly ScorableResult[],
): ScoredCandidate[] {
  const wantedTitle = normalize(title)
  const wantedArtist = normalize(artist)

  const scored = results.map((result, index) => {
    const source = result.source ?? TOPIC_SOURCE
    const candidateTitle = normalize(result.title)
    const candidateUploader = result.uploader ? normalize(result.uploader) : ''

    const titleSim = similarity(wantedTitle, candidateTitle)
    const artistSim = Math.max(
      similarity(wantedArtist, candidateTitle),
      similarity(wantedArtist, candidateUploader),
    )
    let score =
      TITLE_WEIGHT * titleSim +
      ARTIST_WEIGHT * artistSim +
      DURATION_WEIGHT * durationScore(durationS, result.duration)
    if (isTopicChannel(result.uploader, source)) score += TOPIC_BONUS
    if (announcesNotTheRecording(wantedTitle, candidateTitle)) score -= NON_RECORDING_PENALTY

    return {
      index,
      candidate: {
        url: result.url,
        title: result.title,
        uploader: result.uploader,
        duration: result.duration,
        score: Math.max(0, Math.min(1, score)),
        thumbnail: result.thumbnail ?? null,
        source,
      } satisfies ScoredCandidate,
    }
  })

  // Python's `list.sort` is stable, so equal scores keep input order.
  //
  // ⚠️ **Deleting the `a.index - b.index` tiebreak is a mutation that survives
  // the golden suite**, and that is expected rather than a gap: Node's sort is
  // already stable, so jest cannot observe the difference. It is kept for the
  // engine jest is not — the same reason `unicodeNormalize` above is guarded.
  scored.sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index)
  return scored.map((entry) => entry.candidate)
}

/**
 * Does the candidate's title say it is not the recording, when the wanted title
 * does not say the same thing?
 *
 * ⚠️ **The second half is the whole safety of this.** A track legitimately
 * called `教学` must not be demoted for matching a candidate also called
 * `教学` — measured before this was written: that pair scores 1.000, and it
 * still does. The penalty only applies to a marker the *candidate* introduces.
 */
function announcesNotTheRecording(wantedTitle: string, candidateTitle: string): boolean {
  return NON_RECORDING_MARKERS.some(
    (marker) => candidateTitle.includes(marker) && !wantedTitle.includes(marker),
  )
}

/** Map a track's best candidate score to its initial match status. */
export function classify(bestScore: number | null): InitialMatchStatus {
  if (bestScore === null || bestScore < REVIEW_THRESHOLD) return 'no_match'
  if (bestScore >= AUTO_THRESHOLD) return 'auto_matched'
  return 'needs_review'
}
