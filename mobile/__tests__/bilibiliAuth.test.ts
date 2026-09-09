import * as SecureStore from 'expo-secure-store'

import {
  BilibiliHandoffUnreadable,
  BilibiliSignedOut,
  clearBilibiliCredential,
  credentialFrom,
  currentSessdata,
  loadBilibiliCredential,
  pollQrLogin,
  resetBilibiliAuthForTests,
  saveBilibiliCredential,
  startQrLogin,
  useBilibiliAccount,
} from '../src/library/bilibiliAuth'

/**
 * Signing in to Bilibili (#492, slice 3).
 *
 * ## What is real here and what is not
 *
 * The two passport endpoints were **measured** on 2026-08-14 before any of this
 * was written, and the fixtures below are those responses:
 *
 *     generate → code 0, data.url = https://account.bilibili.com/h5/…scan-web?…
 *     poll     → code 0, data: { url: "", refresh_token: "", code: 86101 }
 *
 * ⚠️ **The success payload is now measured too, and it was not what this file
 * assumed** (2026-08-15). It needed a real scan from a real account, which #533
 * shipped without; the guess it shipped instead is the whole of the login bug.
 * Captured twice, by driving a scan through the phone's own Bilibili app:
 *
 *     data.url    → ?ticket=…&gourl=…&first_domain=…   — no credential at all
 *     Set-Cookie  → SESSDATA, bili_jct, DedeUserID, DedeUserID__ckMd5, sid
 *
 * `REAL_COOKIES` and `TICKET_HANDOFF` below are those two shapes. Nothing in
 * this file is assumed any more, which is the point: a wrong guess here is a
 * login that completes and stores nothing, and that is exactly what happened.
 *
 * ⚠️ **The outer `code` is 0 throughout.** Every fixture keeps that, because a
 * reader that branches on it would pass a test that quietly removed the
 * distinction the whole flow turns on.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}))

const store = SecureStore as jest.Mocked<typeof SecureStore>

/**
 * A fake response.
 *
 * ⚠️ **It must be able to carry `Set-Cookie`**, because that is where the
 * credential actually is (measured 2026-08-15). `Headers` here deliberately
 * exposes only `get` — the lowest common denominator, and what React Native may
 * be — so nothing in this suite can pass by relying on Node's `getSetCookie()`,
 * which the phone might not have.
 */
function answer(body: unknown, setCookie: string[] = []) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'set-cookie' && setCookie.length > 0 ? setCookie.join(', ') : null,
    },
  } as unknown as Response)
}

/** The five cookies Bilibili actually sets on a confirmed login, in the order
 *  measured. Values are fake; the names and shape are not. */
const REAL_COOKIES = [
  'SESSDATA=abc%2Cdef%2Cghi%2A31; Path=/; Domain=bilibili.com; Expires=Sat, 12 Sep 2026 10:20:31 GMT; HttpOnly; Secure',
  'bili_jct=secret-csrf-token; Path=/; Domain=bilibili.com; Expires=Sat, 12 Sep 2026 10:20:31 GMT',
  'DedeUserID=12345; Path=/; Domain=bilibili.com; Expires=Sat, 12 Sep 2026 10:20:31 GMT',
  'DedeUserID__ckMd5=aabbcc; Path=/; Domain=bilibili.com',
  'sid=zz11yy; Path=/; Domain=bilibili.com',
]

/** What `data.url` actually carries now: a ticket, and no credential at all. */
const TICKET_HANDOFF =
  'https://passport.biligame.com/x/passport-login/web/crossDomain' +
  '?ticket=abcdef123456&gourl=https%3A%2F%2Fwww.bilibili.com&first_domain=.bilibili.com'

beforeEach(() => {
  jest.clearAllMocks()
  resetBilibiliAuthForTests()
  store.getItemAsync.mockResolvedValue(null)
  store.setItemAsync.mockResolvedValue(undefined)
  store.deleteItemAsync.mockResolvedValue(undefined)
})

describe('starting a login', () => {
  it('returns the URL to encode and the key to poll', async () => {
    global.fetch = jest.fn(() =>
      answer({
        code: 0,
        data: {
          url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=abc',
          qrcode_key: 'abc',
        },
      }),
    ) as unknown as typeof fetch

    await expect(startQrLogin()).resolves.toEqual({
      url: expect.stringContaining('account.bilibili.com'),
      qrcodeKey: 'abc',
    })
  })

  it('fails loudly rather than showing a QR code for nothing', async () => {
    global.fetch = jest.fn(() => answer({ code: -400, data: null })) as unknown as typeof fetch

    await expect(startQrLogin()).rejects.toThrow(/would not start a login/)
  })
})

describe('polling', () => {
  const poll = (data: unknown) => {
    // The outer code is 0 in every one of these, which is the point.
    global.fetch = jest.fn(() => answer({ code: 0, data })) as unknown as typeof fetch
    return pollQrLogin('abc')
  }

  it('reports waiting, which the outer code alone would call success', async () => {
    await expect(poll({ code: 86101, message: '未扫码', url: '' })).resolves.toEqual({
      state: 'waiting',
    })
  })

  it('reports a scan that has not been confirmed yet', async () => {
    await expect(poll({ code: 86090, url: '' })).resolves.toEqual({ state: 'scanned' })
  })

  it('reports an expired code, so the screen can offer a new one', async () => {
    await expect(poll({ code: 86038, url: '' })).resolves.toEqual({ state: 'expired' })
  })

  /**
   * ⚠️ **This is the case #533 got wrong, and it is the whole bug.**
   *
   * `data.url` carries a `ticket` and nothing else; the credential is in
   * `Set-Cookie`. Reading only the query string found no `SESSDATA`, threw, and
   * spent the key — so the *next* poll answered `86038` and the screen said
   * "the code expired". It was never an expiry.
   */
  it('reads the credential out of Set-Cookie, where Bilibili actually puts it', async () => {
    global.fetch = jest.fn(() =>
      answer({ code: 0, data: { code: 0, url: TICKET_HANDOFF } }, REAL_COOKIES),
    ) as unknown as typeof fetch

    await expect(pollQrLogin('abc')).resolves.toEqual({
      state: 'done',
      credential: { sessdata: 'abc,def,ghi*31', userId: '12345' },
      via: 'cookie',
    })
  })

  it('still accepts the documented query-string shape, so one change cannot break both', async () => {
    const url =
      'https://passport.biligame.com/x/passport-login/web/crossDomain' +
      '?DedeUserID=12345&DedeUserID__ckMd5=aa&SESSDATA=abc%2Cdef%2Cghi&bili_jct=jjj'

    await expect(poll({ code: 0, url })).resolves.toEqual({
      state: 'done',
      credential: { sessdata: 'abc,def,ghi', userId: '12345' },
      via: 'query',
    })
  })

  it('says so rather than looping when a confirmed login carries no session', async () => {
    await expect(poll({ code: 0, url: '' })).rejects.toThrow(/returned no session/)
  })

  it('does not mistake a ticket for a credential', async () => {
    // No cookies, only the ticket: exactly what my phone received.
    await expect(poll({ code: 0, url: TICKET_HANDOFF })).rejects.toThrow(/returned no session/)
  })
})

/**
 * What a confirmed-but-unreadable login can say about itself (2026-08-15).
 *
 * I reported the login failing as *"it says the code expired, require new
 * code… no error log caught"*, and the second half is what made the first half
 * undiagnosable. The failure has a shape that produces exactly that report: a
 * **confirmed** scan hands back something unreadable, the poll throws, the key
 * is now spent, and two seconds later Bilibili answers `86038` — so the screen
 * truthfully says "expired" while nothing records that a login had in fact
 * succeeded.
 *
 * This module still logs nothing itself — `bilibiliCredentialNeverLogged`
 * holds that line, and it is the right one: the file that holds the credential
 * should not be relying on `scrub()`, which is a net rather than a policy. So
 * the *shape* travels out on a typed error and the screen writes it down.
 */
describe('the error a confirmed login throws', () => {
  const poll = (data: unknown) => {
    global.fetch = jest.fn(() => answer({ code: 0, data })) as unknown as typeof fetch
    return pollQrLogin('abc')
  }

  it('is typed, so the caller can tell it from a network failure', async () => {
    const url = 'https://passport.biligame.com/x/passport-login/web/crossDomain?gourl=x&Expires=1'

    await expect(poll({ code: 0, url })).rejects.toBeInstanceOf(BilibiliHandoffUnreadable)
  })

  it('carries the parameter names, which say whether the hand-off changed shape', async () => {
    const url = 'https://passport.biligame.com/x/passport-login/web/crossDomain?gourl=x&Expires=1'

    const error = await poll({ code: 0, url }).catch((e: unknown) => e)

    expect((error as BilibiliHandoffUnreadable).describe()).toBe(
      'handoffLength=80 keys=[gourl Expires] cookies=[]',
    )
  })

  it('carries no value from the hand-off, only a length and the names', async () => {
    const url = 'https://passport.biligame.com/c?DedeUserID=12345&SESSDATA=abc%2Cdef&bili_jct=jjj'
    // A hand-off with a SESSDATA but no DedeUserID is unreadable, and is the
    // case where a leak would actually have something to leak.
    const partial = url.replace('DedeUserID=12345&', '')

    const error = (await poll({ code: 0, url: partial }).catch((e: unknown) => e)) as Error
    const described = (error as BilibiliHandoffUnreadable).describe()

    expect(described).not.toContain('abc,def')
    expect(described).not.toContain('jjj')
    expect(described).toContain('keys=[SESSDATA bili_jct]')
  })
})

/**
 * Reading the credential out of `Set-Cookie` (measured 2026-08-15).
 *
 * Two captures, driven through the phone's own Bilibili app so a real account
 * confirmed a real scan. Both times:
 *
 *     data.url    → ?ticket=…&gourl=…&first_domain=…      (no credential)
 *     Set-Cookie  → SESSDATA, bili_jct, DedeUserID,
 *                   DedeUserID__ckMd5, sid                (5 headers)
 *
 * The hazards below are all in that real payload, which is why they are tested
 * rather than assumed:
 *
 * - `DedeUserID__ckMd5` sits next to `DedeUserID` in the same blob. That one is
 *   excluded by the `=` rather than by the anchor — a fact worth writing down,
 *   because the first version of this test claimed the anchor did it and the
 *   mutation survived. What the anchor stops is a name **ending** with the one
 *   wanted.
 * - Every cookie carries attributes (`Path`, `Expires`, `HttpOnly`) after a
 *   `;`, so the value has to stop there or the whole attribute list is stored
 *   as the credential.
 * - A `Headers.get` that joins repeats with `, ` makes a comma a separator
 *   *between* cookies. `Expires=Sat, 12 Sep 2026 …` also contains one, but that
 *   is inside the attributes and the `;` has already ended the value — a
 *   distinction the first version of this suite got wrong, and the mutation
 *   said so.
 * - `bili_jct` is in there and must not be stored: it is the token for *writes*.
 */
describe('the credential in Set-Cookie', () => {
  const confirmed = (cookies: string[], url = TICKET_HANDOFF) => {
    global.fetch = jest.fn(() =>
      answer({ code: 0, data: { code: 0, url } }, cookies),
    ) as unknown as typeof fetch
    return pollQrLogin('abc')
  }

  it('picks DedeUserID and not the md5 sitting beside it', async () => {
    // The md5 cookie comes *first*, so a reader that scanned for the substring
    // would take it. (The `=` is what excludes it, not the anchor — see above.)
    const reordered = [
      'DedeUserID__ckMd5=aabbcc; Path=/',
      'SESSDATA=abc%2Cdef; Path=/',
      'DedeUserID=12345; Path=/',
    ]

    await expect(confirmed(reordered)).resolves.toEqual({
      state: 'done',
      credential: { sessdata: 'abc,def', userId: '12345' },
      via: 'cookie',
    })
  })

  it('does not match a cookie whose name merely ends with the one wanted', async () => {
    // This is what the boundary anchor buys. Bilibili sets no such cookie
    // today; the point is that a name it adds tomorrow cannot hijack the read,
    // and the credential is not the place to find that out.
    const shadowed = [
      'legacy_SESSDATA=stale-value; Path=/',
      'legacy_DedeUserID=99999; Path=/',
      'SESSDATA=abc%2Cdef; Path=/',
      'DedeUserID=12345; Path=/',
    ]

    await expect(confirmed(shadowed)).resolves.toEqual({
      state: 'done',
      credential: { sessdata: 'abc,def', userId: '12345' },
      via: 'cookie',
    })
  })

  it('stops the value at the attributes, not at the end of the header', async () => {
    const status = await confirmed(REAL_COOKIES)

    // Every measured cookie is `NAME=value; Path=…; Expires=…`. Without the
    // `;` stop, the stored credential would be the whole attribute list.
    expect(status).toEqual({
      state: 'done',
      credential: { sessdata: 'abc,def,ghi*31', userId: '12345' },
      via: 'cookie',
    })
  })

  it('ends a value at the comma joining it to the next cookie', async () => {
    // `Headers.get` joins repeated headers with ", ". A cookie carrying no
    // attributes therefore runs straight into the next one, and only the comma
    // separates them — the measured payload always had attributes, so this is
    // the case that is one Bilibili change away rather than one already seen.
    const bare = ['SESSDATA=abc%2Cdef', 'DedeUserID=12345']

    await expect(confirmed(bare)).resolves.toEqual({
      state: 'done',
      credential: { sessdata: 'abc,def', userId: '12345' },
      via: 'cookie',
    })
  })

  it('never stores bili_jct, which is in the cookies too', async () => {
    const status = await confirmed(REAL_COOKIES)

    expect(JSON.stringify(status)).not.toContain('secret-csrf-token')
    expect(Object.keys((status as { credential: object }).credential)).toEqual([
      'sessdata',
      'userId',
    ])
  })

  it('needs both cookies, because half a credential reads nothing', async () => {
    await expect(confirmed(['SESSDATA=abc%2Cdef; Path=/'])).rejects.toThrow(/returned no session/)
  })

  it('names the cookies it did get, which is how this change was found', async () => {
    const error = (await confirmed(['ticket=abc; Path=/', 'sid=zz; Path=/']).catch(
      (e: unknown) => e,
    )) as BilibiliHandoffUnreadable

    // One line naming `ticket sid` would have said "the credential moved"
    // immediately, instead of costing a day.
    expect(error.describe()).toContain('cookies=[ticket sid]')
  })
})

/**
 * ⚠️ **`URLSearchParams` is not the same object here as it is on the phone.**
 *
 * Hermes ships none, so React Native polyfills one whose parser is
 * `pair.split('=')` with a two-element destructure — which **truncates** a value
 * containing an unencoded `=`. Node's, which is what jest runs, keeps it.
 * Measured 2026-08-15 against `react-native@0.86`'s
 * `Libraries/Blob/URLSearchParams.js`:
 *
 *     'SESSDATA=abc,def,CjB1eQ=='   node → 'abc,def,CjB1eQ=='
 *                                   RN   → 'abc,def,CjB1eQ'
 *
 * A test written against jest's object cannot see that, which is the trap
 * `docs/lessons.md` names. So this suite installs React Native's own
 * implementation and runs the parser against it: `credentialFrom` must not
 * depend on `URLSearchParams` at all, and if anyone puts it back, these fail.
 *
 * A truncated `SESSDATA` is the worst shape available — it stores, the screen
 * says signed in, and every folder read then answers `-101`, which the UI
 * honestly reports as "sign in again".
 */
describe('parsing the hand-off the way the phone will', () => {
  const real = global.URLSearchParams

  beforeAll(() => {
    // Transcribed from react-native/Libraries/Blob/URLSearchParams.js — only
    // the constructor and `get`, which is all `credentialFrom` ever used.
    class HermesURLSearchParams {
      private params = new Map<string, string[]>()
      constructor(input?: string) {
        if (typeof input !== 'string') return
        input
          .replace(/^\?/, '')
          .split('&')
          .forEach((pair) => {
            if (!pair) return
            const [key, value] = pair
              .split('=')
              .map((part) => decodeURIComponent(part.replace(/\+/g, ' ')))
            const existing = this.params.get(key)
            if (existing) existing.push(value)
            else this.params.set(key, [value])
          })
      }
      get(name: string): string | null {
        return this.params.get(name)?.[0] ?? null
      }
    }
    global.URLSearchParams = HermesURLSearchParams as unknown as typeof URLSearchParams
  })

  afterAll(() => {
    global.URLSearchParams = real
  })

  it('keeps a SESSDATA that contains an unencoded "="', () => {
    const url = 'https://passport.biligame.com/c?DedeUserID=12345&SESSDATA=abc%2Cdef%2CCjB1eQ=='

    // The whole value, padding included. React Native's object stops at `CjB1eQ`.
    expect(credentialFrom(url)?.credential).toEqual({
      sessdata: 'abc,def,CjB1eQ==',
      userId: '12345',
    })
  })

  it('still reads an ordinary hand-off', () => {
    const url =
      'https://passport.biligame.com/x/passport-login/web/crossDomain' +
      '?DedeUserID=12345&DedeUserID__ckMd5=aa&SESSDATA=abc%2Cdef%2Cghi&bili_jct=jjj'

    expect(credentialFrom(url)?.credential).toEqual({ sessdata: 'abc,def,ghi', userId: '12345' })
  })

  it('survives a value that is not valid percent-encoding', () => {
    // `decodeURIComponent('100%')` throws. A login is not the place to find out.
    const url = 'https://passport.biligame.com/c?DedeUserID=12345&SESSDATA=100%'

    expect(credentialFrom(url)?.credential).toEqual({ sessdata: '100%', userId: '12345' })
  })

  it('returns null rather than half a credential', () => {
    expect(credentialFrom('https://passport.biligame.com/c?DedeUserID=12345')).toBeNull()
    expect(credentialFrom('https://passport.biligame.com/c')).toBeNull()
    expect(credentialFrom('')).toBeNull()
  })
})

describe('what is taken out of the hand-off URL', () => {
  const url =
    'https://passport.biligame.com/x/passport-login/web/crossDomain' +
    '?DedeUserID=12345&SESSDATA=abc&bili_jct=secret-csrf-token'

  it('keeps only what a read needs', () => {
    expect(credentialFrom(url)?.credential).toEqual({ sessdata: 'abc', userId: '12345' })
  })

  /*
   * The blast-radius decision, and it is a decision rather than an oversight.
   * `bili_jct` is the CSRF token for **writes**; a private folder was measured
   * reading back with SESSDATA alone on 2026-08-14, so keeping it would buy
   * nothing and mean a leaked store could post as the user.
   */
  it('never keeps bili_jct, which is the token for writing', () => {
    expect(JSON.stringify(credentialFrom(url))).not.toContain('secret-csrf-token')
    expect(Object.keys(credentialFrom(url)?.credential ?? {})).toEqual(['sessdata', 'userId'])
  })

  it('is null for a URL that carries neither', () => {
    expect(credentialFrom('https://example.com/no-query')).toBeNull()
    expect(credentialFrom('https://example.com/?bili_jct=only')).toBeNull()
  })
})

describe('the stored credential', () => {
  it('is not readable before it is loaded, and does not throw', () => {
    expect(currentSessdata()).toBeNull()
  })

  it('round-trips through SecureStore', async () => {
    await saveBilibiliCredential({ sessdata: 'abc', userId: '12345' })

    expect(store.setItemAsync).toHaveBeenCalledWith('mio_bilibili_sessdata', 'abc')
    expect(currentSessdata()).toBe('abc')
    expect(useBilibiliAccount.getState()).toEqual({ signedIn: true, userId: '12345' })
  })

  it('needs both halves, because half of one reads nothing', async () => {
    store.getItemAsync.mockImplementation((key: string) =>
      Promise.resolve(key === 'mio_bilibili_sessdata' ? 'abc' : null),
    )

    await expect(loadBilibiliCredential()).resolves.toBeNull()
    expect(currentSessdata()).toBeNull()
  })

  it('reads SecureStore once and then the cache', async () => {
    store.getItemAsync.mockResolvedValue('abc')

    await loadBilibiliCredential()
    await loadBilibiliCredential()

    // Two keys, one load — not four.
    expect(store.getItemAsync).toHaveBeenCalledTimes(2)
  })

  /*
   * A disconnect that leaves the credential live for another few hundred
   * milliseconds is not a disconnect, so the cache is cleared before the
   * deletes are awaited.
   */
  it('stops being readable the instant disconnect is called', async () => {
    await saveBilibiliCredential({ sessdata: 'abc', userId: '12345' })

    const clearing = clearBilibiliCredential()

    expect(currentSessdata()).toBeNull()
    expect(useBilibiliAccount.getState().signedIn).toBe(false)
    await clearing
    expect(store.deleteItemAsync).toHaveBeenCalledWith('mio_bilibili_sessdata')
    expect(store.deleteItemAsync).toHaveBeenCalledWith('mio_bilibili_user_id')
  })
})

describe('a dead session', () => {
  it('is its own error type, not a refusal about the folder', () => {
    // The rule: expiry must say "sign in again", never "this list is private".
    // They ask for opposite actions and there is no refresh token, so this
    // happens on a schedule nobody controls.
    const signedOut = new BilibiliSignedOut('账号未登录')

    expect(signedOut.name).toBe('BilibiliSignedOut')
    expect(signedOut).toBeInstanceOf(Error)
  })
})
