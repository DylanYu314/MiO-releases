/**
 * Reading a public Bilibili favourites folder (#492, slice 3).
 *
 * ## Why this exists at all, and why it is not search
 *
 * `docs/bilibili.md` §2.1 measured a real rate ceiling on Bilibili's **search**
 * endpoint — ~90 requests from one address, then 412 for about fifteen minutes,
 * which a fresh cookie does not clear. That is why search is out of scope.
 *
 * **This path is not that path.** A folder import is one or two `x/v3/fav/…`
 * calls plus a `view`/`playurl` pair per entry, none of which is metered. The
 * "a 130-track import is over the ceiling" worry came from YouTube's shape,
 * where every track needs its own *search*. A favourites folder hands back exact
 * video ids, so there is nothing to search for — the same reason #106 has no
 * review step (ADR-014).
 *
 * ## What the real list actually contained
 *
 * Every rule below was read off `media_id=486002245`, a real 55-entry public
 * folder, on 2026-08-13. The plan required that read before this file was
 * written, because every list found before it had been empty — access had been
 * demonstrated and **parsing never had**.
 *
 *     ps=20 returned 19 medias, ps=40 returned 39   → page on `has_more`
 *     attr 0×16, 1×1, 9×2 — and exactly the three
 *       non-zero rows were titled 已失效视频        → attr !== 0 means gone
 *     duration was 14118, an integer of seconds     → not search's "4:30"
 *     type was 2 throughout                          → 12 and 24 unseen
 *
 * ⚠️ **Dead entries count toward `media_count`.** A 55-entry folder yielding 52
 * songs is correct, not a bug — which is why the caller counts *tracks fetched*
 * rather than list position, as #389 already made it.
 */

import { apiCall, newBuvid3 } from './bilibili'
import { overHttps } from './extract'
import { canonicalUrlFor } from './bilibiliUrl'

const API = 'https://api.bilibili.com'

/**
 * How many entries to ask for per page.
 *
 * 40 rather than 20 because the measurement showed the page size is honoured up
 * to at least that, and halving the number of requests on an unmetered endpoint
 * is free. It is **not** treated as the number that will come back.
 */
const PAGE_SIZE = 40

/**
 * A hard stop on paging, so a `has_more` that never goes false cannot spin
 * forever. 2000 entries is far past any real folder and still bounded.
 */
const MAX_PAGES = 50

/** Bilibili's `type` for an ordinary video. `12` is audio and `24` is a season;
 *  both exist, neither was seen, and neither is a `bvid` we can fetch. */
const TYPE_VIDEO = 2

/** One fetchable entry, already reduced to what the import loop needs. */
export type FavEntry = {
  /** The canonical `https://www.bilibili.com/video/<bvid>` — the library identity. */
  url: string
  bvid: string
  title: string
  uploader: string
  /** Seconds, as Bilibili gives it here. `null` when it was absent. */
  durationSeconds: number | null
  coverUrl: string | null
}

/** A folder, as the import screen needs to show it. */
export type FavList = {
  mediaId: string
  title: string
  uploader: string
  /** What Bilibili claims the folder holds, **including dead entries**. */
  declaredCount: number
  /** What is actually fetchable — always `<= declaredCount`. */
  entries: FavEntry[]
  /** How many rows were skipped as dead or as a type we cannot fetch. Surfaced
   *  so "55 in the folder, 52 imported" is explainable rather than alarming. */
  skipped: number
}

type RawMedia = {
  bvid?: unknown
  bv_id?: unknown
  title?: unknown
  cover?: unknown
  duration?: unknown
  attr?: unknown
  type?: unknown
  upper?: { name?: unknown }
}

/**
 * Whether an entry can be fetched at all.
 *
 * `attr !== 0` is the measured signal for "gone" — on the real folder it
 * selected exactly the rows Bilibili had already retitled 已失效视频, and
 * nothing else. An absent `attr` is treated as present-and-fine, because the
 * field is documented nowhere and a missing one must not delete a good song.
 */
function isFetchable(media: RawMedia): boolean {
  const attr = typeof media.attr === 'number' ? media.attr : 0
  const type = typeof media.type === 'number' ? media.type : TYPE_VIDEO
  return attr === 0 && type === TYPE_VIDEO
}

/**
 * Bilibili spells image URLs two ways and `overHttps` only fixes one.
 *
 * This endpoint returned `http://i0.hdslb.com/…`, which `overHttps` handles.
 * The **search** endpoint returns the protocol-relative `//i0.hdslb.com/…`,
 * which it does not — its regex is anchored on `http://`, so a
 * protocol-relative URL passes through unchanged and reaches `<Image>` as
 * something it cannot load. Both forms are handled here rather than assuming
 * the one this endpoint happened to send.
 */
function coverOverHttps(cover: string | null): string | null {
  if (cover === null) return null
  return overHttps(cover.startsWith('//') ? `https:${cover}` : cover)
}

function entryFrom(media: RawMedia): FavEntry | null {
  const bvid = typeof media.bvid === 'string' ? media.bvid : media.bv_id
  if (typeof bvid !== 'string' || bvid === '') return null

  const cover = typeof media.cover === 'string' && media.cover !== '' ? media.cover : null

  return {
    url: canonicalUrlFor(bvid),
    bvid,
    title: typeof media.title === 'string' ? media.title : bvid,
    uploader: typeof media.upper?.name === 'string' ? media.upper.name : '',
    durationSeconds: typeof media.duration === 'number' ? media.duration : null,
    coverUrl: coverOverHttps(cover),
  }
}

/**
 * Read a whole public favourites folder.
 *
 * Pages until `has_more` is false, **never** by dividing `media_count` by the
 * page size: the measurement showed a `ps=20` request answering with 19 rows
 * and a `ps=40` answering with 39, so any arithmetic over the declared count
 * stops one short of the end on every page.
 *
 * A private folder throws `VideoUnavailable` from `apiCall`, which already maps
 * Bilibili's `-403`. That is deliberately not caught here — the screen names it,
 * and swallowing it would turn "this list is private" into an empty list.
 */
export async function fetchFavList(mediaId: string): Promise<FavList> {
  const buvid3 = newBuvid3()

  let title = ''
  let uploader = ''
  let declaredCount = 0
  const entries: FavEntry[] = []
  let skipped = 0

  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = `media_id=${encodeURIComponent(mediaId)}&pn=${page}&ps=${PAGE_SIZE}&platform=web`
    const data = (await apiCall(`${API}/x/v3/fav/resource/list?${query}`, buvid3)) as {
      info?: { title?: unknown; media_count?: unknown; upper?: { name?: unknown } }
      medias?: unknown
      has_more?: unknown
    }

    // The folder's own details ride on every page; take them from the first,
    // which is the only one guaranteed to exist.
    if (page === 1) {
      title = typeof data.info?.title === 'string' ? data.info.title : ''
      uploader = typeof data.info?.upper?.name === 'string' ? data.info.upper.name : ''
      declaredCount = typeof data.info?.media_count === 'number' ? data.info.media_count : 0
    }

    // `medias` is null rather than [] on an empty folder, which is why this
    // checks the array rather than trusting the field to exist.
    const medias = Array.isArray(data.medias) ? (data.medias as RawMedia[]) : []
    for (const media of medias) {
      if (!isFetchable(media)) {
        skipped++
        continue
      }
      const entry = entryFrom(media)
      if (entry === null) skipped++
      else entries.push(entry)
    }

    if (data.has_more !== true) break
    // A page that came back empty while still claiming more would otherwise
    // spin to MAX_PAGES for nothing.
    if (medias.length === 0) break
  }

  return { mediaId, title, uploader, declaredCount, entries, skipped }
}

/** One of the signed-in user's own folders, as the picker needs it. */
export type FavFolder = {
  mediaId: string
  title: string
  /** What Bilibili claims it holds, dead entries included. */
  declaredCount: number
  /** Bit 0 of `attr`. Shown, because "these are the ones only you can see" is
   *  the entire point of signing in — and a public folder needed no login. */
  isPrivate: boolean
}

/**
 * The signed-in user's own favourites folders (#492, slice 3).
 *
 * `up_mid` is a query parameter rather than something the cookie implies, which
 * is why the credential carries `DedeUserID` alongside `SESSDATA`.
 *
 * ⚠️ **Private folders need the session**, and without one this answers the
 * public subset rather than failing — so an empty-looking result is a plausible
 * shape for "not signed in". The caller checks the credential first; this does
 * not guess.
 *
 * `attr & 1` is the private bit. Confirmed against a real account on
 * 2026-08-14: 19 folders, all reporting private, and `x/v3/fav/resource/list`
 * read one of them back with `SESSDATA` alone.
 */
export async function fetchFavFolders(userId: string): Promise<FavFolder[]> {
  const buvid3 = newBuvid3()
  const data = (await apiCall(
    `${API}/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(userId)}`,
    buvid3,
  )) as { list?: unknown }

  const list = Array.isArray(data.list) ? data.list : []
  return list.flatMap((row): FavFolder[] => {
    const folder = row as { id?: unknown; title?: unknown; media_count?: unknown; attr?: unknown }
    // `id` is the `media_id` every other fav endpoint takes.
    if (typeof folder.id !== 'number') return []
    return [
      {
        mediaId: String(folder.id),
        title: typeof folder.title === 'string' ? folder.title : String(folder.id),
        declaredCount: typeof folder.media_count === 'number' ? folder.media_count : 0,
        isPrivate: typeof folder.attr === 'number' ? (folder.attr & 1) === 1 : false,
      },
    ]
  })
}
