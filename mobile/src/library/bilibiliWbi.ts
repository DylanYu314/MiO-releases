import * as Crypto from 'expo-crypto'

/**
 * WBI signing for Bilibili's web API (#729 device pass, 2026-09-08).
 *
 * ## ⛔ Why this exists now
 *
 * `bilibili.ts` said, when it was written:
 *
 * > yt-dlp signs `x/player/wbi/playurl` … The **legacy** endpoint used here
 * > answered with full DASH and needs none of it. Signing is about twenty-five
 * > lines if that ever stops being true.
 *
 * It stopped being enough. ⛔ **Not "stopped being true" — the first version of
 * this comment said the unsigned endpoint had been *retired*, and I
 * disproved it in one sentence: Bilibili add-link still worked on my phone.**
 *
 * ⚠️ **That was a single 412 generalised without alternating** — precisely the
 * mistake `docs/lessons.md` records from #492, where a fresh address gets a
 * request or two before the refusals start and alternating was the only thing
 * that stopped it becoming a fourth wrong story. This was the fourth wrong
 * story, in a file that had been warned by name.
 *
 * **What is actually measured** (2026-09-08, 12 distinct videos, alternating
 * signed against unsigned, same cookie jar, ~1.5 s apart — the import's own
 * pace):
 *
 *     x/web-interface/view       (unsigned)   ->  0/12 OK, twelve 412s
 *     x/web-interface/wbi/view   (signed)     -> 12/12 OK
 *
 * And in isolation, one unsigned request at a time, it sometimes answers 200.
 *
 * ⭐ **So the refusal is about sustained use, not about the endpoint existing.**
 * That is why a single add-link works and a 28-track import failed on every
 * Bilibili track: one request is tolerated, twelve in a row are not. Signing is
 * what survives the second case, and the alternating pair is what says so —
 * `pagelist`, `search/type`, `playurl` and `card` were also 200 throughout,
 * so this is not a blanket refusal of the address either.
 *
 * ## How the signature works
 *
 * `x/web-interface/nav` returns two image URLs whose filenames are `img_key`
 * and `sub_key`. Concatenated and reordered by a fixed 64-entry table, the
 * first 32 characters are the **mixin key**. A request is then
 * `md5(sorted_query + wts + mixin_key)`, sent as `w_rid`.
 *
 * ⚠️ **The keys rotate**, so the mixin key is cached with an expiry rather than
 * fetched once and kept forever.
 */

/**
 * Bilibili's shuffle table. A constant of theirs, not a choice of ours — it is
 * transcribed, and the only correct thing to do with it is leave it alone.
 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

/** How long a mixin key is reused. They rotate daily; this is well inside that. */
const KEY_TTL_MS = 60 * 60 * 1000

/** The filename of a wbi image URL, which is the key itself. */
export function keyFromUrl(url: string): string {
  const file = url.split('/').pop() ?? ''
  return file.split('.')[0] ?? ''
}

/** Concatenate, reorder by Bilibili's table, take 32. */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '')
    .join('')
    .slice(0, 32)
}

/**
 * The query string that gets signed, and is then sent verbatim.
 *
 * ⚠️ **Sorted, and the order is part of the signature** — a different order
 * hashes differently and Bilibili rejects it. So the same string has to be both
 * hashed and sent; building it twice is how that goes wrong.
 *
 * ⚠️ `!'()*` are stripped from values. `encodeURIComponent` leaves them alone
 * and Bilibili's own implementation does not, so a title containing one would
 * sign correctly here and be refused there.
 */
export function signableQuery(params: Record<string, string | number>, wts: number): string {
  return Object.entries({ ...params, wts })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => {
      const cleaned = String(value).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(key)}=${encodeURIComponent(cleaned)}`
    })
    .join('&')
}

let cached: { key: string; at: number } | null = null

/** Test seam: the cache is module state and outlives a test. */
export function resetWbiKeyCache(): void {
  cached = null
}

/**
 * The current mixin key, fetched at most once an hour.
 *
 * ⚠️ `nav` answers `code: -101` ("not logged in") for an anonymous caller and
 * **still returns the keys**, which is why the code is not checked. Treating
 * -101 as a failure would break signing for everyone who is not signed in —
 * that is, everyone.
 */
export async function currentMixinKey(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  now: number = Date.now(),
): Promise<string> {
  if (cached && now - cached.at < KEY_TTL_MS) return cached.key

  const response = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', { headers })
  const body = (await response.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string } }
  }
  const img = body.data?.wbi_img?.img_url ?? ''
  const sub = body.data?.wbi_img?.sub_url ?? ''
  const key = mixinKey(keyFromUrl(img), keyFromUrl(sub))

  if (key.length !== 32) {
    throw new Error(`bilibili nav gave no usable wbi keys (got ${key.length} chars)`)
  }

  cached = { key, at: now }
  return key
}

/** `md5(query + mixinKey)`, which is what `w_rid` is. */
export async function signature(query: string, mixin: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.MD5, query + mixin)
}

/**
 * A signed URL for a wbi endpoint.
 *
 * The signed query is reused rather than rebuilt, because the string that was
 * hashed and the string that is sent must be identical.
 */
export async function signedUrl(
  endpoint: string,
  params: Record<string, string | number>,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  now: number = Date.now(),
): Promise<string> {
  const mixin = await currentMixinKey(fetchImpl, headers, now)
  const query = signableQuery(params, Math.floor(now / 1000))
  const wRid = await signature(query, mixin)
  return `${endpoint}?${query}&w_rid=${wRid}`
}
