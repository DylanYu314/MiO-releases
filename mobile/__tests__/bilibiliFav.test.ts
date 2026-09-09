/**
 * #492 slice 3 — reading a public favourites folder.
 *
 * The fixtures below are the **real** shapes read off `media_id=486002245` on
 * 2026-08-13, not invented ones. That matters more than usual here: every list
 * anyone had found before was empty, so access had been demonstrated and
 * parsing never had, and the plan required a real read before this code existed.
 */

import {
  favIdFrom,
  isBilibiliFavList,
  canonicalFavUrlFor,
  NotABilibiliFavList,
} from '../src/library/bilibiliFavUrl'
import { fetchFavList } from '../src/library/bilibiliFav'

describe('favIdFrom', () => {
  it.each([
    ['https://space.bilibili.com/440225545/favlist?fid=486002245', '486002245'],
    ['https://space.bilibili.com/440225545/favlist?fid=486002245&ftype=create', '486002245'],
    ['https://space.bilibili.com/440225545/lists/486002245', '486002245'],
    ['https://www.bilibili.com/medialist/detail/ml486002245', '486002245'],
    ['https://m.bilibili.com/medialist/detail/ml486002245', '486002245'],
    ['ml486002245', '486002245'],
    ['486002245', '486002245'],
    ['  https://space.bilibili.com/1/favlist?fid=486002245  ', '486002245'],
  ])('reads %s', (input, expected) => {
    expect(favIdFrom(input)).toBe(expected)
  })

  it.each([
    'https://www.bilibili.com/video/BV1BZbSzZEGT',
    'https://space.bilibili.com/440225545',
    'https://space.bilibili.com/440225545/favlist',
    'https://www.youtube.com/playlist?list=PL1',
    'not a url',
    '',
  ])('refuses %s', (input) => {
    expect(() => favIdFrom(input)).toThrow(NotABilibiliFavList)
  })

  it('refuses a collection, which shares the favlist path', () => {
    // `type=season` is a collection with a different endpoint. Reading it as a
    // folder would fetch an id that does not exist and report Bilibili's answer
    // about it, which is a confusing way to say "wrong kind of link".
    expect(() =>
      favIdFrom('https://space.bilibili.com/440225545/favlist?fid=123&type=season'),
    ).toThrow(NotABilibiliFavList)
  })

  it('keeps the id a string, because these overflow a float', () => {
    // 3409179931123456 is past Number.MAX_SAFE_INTEGER's precision for the
    // round trip that matters; the id only ever travels back out as a query
    // parameter, so it stays text.
    expect(favIdFrom('ml3409179931123456')).toBe('3409179931123456')
  })
})

describe('isBilibiliFavList', () => {
  it('is true for a folder and false for a video', () => {
    expect(isBilibiliFavList('https://space.bilibili.com/1/favlist?fid=486002245')).toBe(true)
    expect(isBilibiliFavList('https://www.bilibili.com/video/BV1BZbSzZEGT')).toBe(false)
  })
})

describe('canonicalFavUrlFor', () => {
  it('round-trips through favIdFrom', () => {
    expect(favIdFrom(canonicalFavUrlFor('486002245'))).toBe('486002245')
  })
})

// ── the reader ──────────────────────────────────────────────────────────────

const okResponse = (data: unknown) => ({
  ok: true,
  status: 200,
  url: '',
  json: async () => ({ code: 0, message: '0', data }),
})

/** A row shaped exactly like the real ones. */
const media = (over: Record<string, unknown> = {}) => ({
  id: 116853997308738,
  type: 2,
  title: '晴天',
  cover: 'http://i0.hdslb.com/bfs/archive/abc.jpg',
  duration: 270,
  upper: { mid: 2143022340, name: '小云听不说' },
  attr: 0,
  bv_id: 'BV1axTp6uEDy',
  bvid: 'BV1axTp6uEDy',
  ...over,
})

const info = (over: Record<string, unknown> = {}) => ({
  title: '默认收藏夹',
  media_count: 55,
  upper: { name: '无损杠' },
  ...over,
})

describe('fetchFavList', () => {
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  it('reads a folder and its entries', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        info: info(),
        medias: [media(), media({ bvid: 'BV2', bv_id: 'BV2' })],
        has_more: false,
      }),
    )

    const list = await fetchFavList('486002245')

    expect(list.title).toBe('默认收藏夹')
    expect(list.uploader).toBe('无损杠')
    expect(list.declaredCount).toBe(55)
    expect(list.entries).toHaveLength(2)
    expect(list.entries[0]).toEqual({
      url: 'https://www.bilibili.com/video/BV1axTp6uEDy',
      bvid: 'BV1axTp6uEDy',
      title: '晴天',
      uploader: '小云听不说',
      durationSeconds: 270,
      coverUrl: 'https://i0.hdslb.com/bfs/archive/abc.jpg',
    })
  })

  it('sends the buvid3 cookie, which is the whole feature', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({ info: info(), medias: [], has_more: false }))
    await fetchFavList('486002245')

    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.Cookie).toMatch(/^buvid3=[0-9a-f-]+infoc$/)
    expect(headers.Referer).toBe('https://www.bilibili.com/')
  })

  it('skips dead entries — attr !== 0 — and counts them', async () => {
    // Measured: exactly the non-zero-attr rows were the ones Bilibili had
    // already retitled 已失效视频.
    fetchMock.mockResolvedValueOnce(
      okResponse({
        info: info(),
        medias: [
          media(),
          media({ attr: 1, title: '已失效视频', bvid: 'BVdead1', bv_id: 'BVdead1' }),
          media({ attr: 9, title: '已失效视频', bvid: 'BVdead2', bv_id: 'BVdead2' }),
        ],
        has_more: false,
      }),
    )

    const list = await fetchFavList('486002245')

    expect(list.entries).toHaveLength(1)
    expect(list.skipped).toBe(2)
  })

  it('skips a type it cannot fetch, rather than assuming it is a video', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        info: info(),
        medias: [media(), media({ type: 12, bvid: 'BVaudio' })],
        has_more: false,
      }),
    )

    const list = await fetchFavList('486002245')
    expect(list.entries).toHaveLength(1)
    expect(list.skipped).toBe(1)
  })

  it('pages on has_more, not on arithmetic over media_count', async () => {
    // The measured trap: ps=20 answered with 19 rows and ps=40 with 39, so
    // dividing media_count by the page size stops one page short.
    fetchMock
      .mockResolvedValueOnce(okResponse({ info: info(), medias: [media()], has_more: true }))
      .mockResolvedValueOnce(
        okResponse({ info: info(), medias: [media({ bvid: 'BV2' })], has_more: true }),
      )
      .mockResolvedValueOnce(
        okResponse({ info: info(), medias: [media({ bvid: 'BV3' })], has_more: false }),
      )

    const list = await fetchFavList('486002245')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(list.entries).toHaveLength(3)
    expect(list.declaredCount).toBe(55)
  })

  it('asks for the next page number each time', async () => {
    fetchMock
      .mockResolvedValueOnce(okResponse({ info: info(), medias: [media()], has_more: true }))
      .mockResolvedValueOnce(okResponse({ info: info(), medias: [media()], has_more: false }))

    await fetchFavList('486002245')

    expect(fetchMock.mock.calls[0][0]).toContain('pn=1')
    expect(fetchMock.mock.calls[1][0]).toContain('pn=2')
  })

  it('stops when a page comes back empty even if has_more stays true', async () => {
    fetchMock.mockResolvedValue(okResponse({ info: info(), medias: [], has_more: true }))
    const list = await fetchFavList('486002245')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(list.entries).toHaveLength(0)
  })

  it('handles medias being null on an empty folder', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({ info: info({ media_count: 0 }), medias: null, has_more: false }),
    )
    const list = await fetchFavList('486002245')
    expect(list.entries).toEqual([])
    expect(list.declaredCount).toBe(0)
  })

  it('rewrites a protocol-relative cover, which overHttps alone does not', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        info: info(),
        medias: [media({ cover: '//i0.hdslb.com/x.jpg' })],
        has_more: false,
      }),
    )
    const list = await fetchFavList('486002245')
    expect(list.entries[0].coverUrl).toBe('https://i0.hdslb.com/x.jpg')
  })

  it('lets a private folder throw rather than reporting it empty', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: '',
      json: async () => ({ code: -403, message: '访问权限不足', data: null }),
    })

    await expect(fetchFavList('486002245')).rejects.toThrow(/访问权限不足/)
  })
})
