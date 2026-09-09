import * as SecureStore from 'expo-secure-store'
import { create } from 'zustand'

/**
 * Signing in to Bilibili with a QR code (#492, slice 3).
 *
 * ## Why a QR code, and not OAuth
 *
 * Bilibili offers third parties **no OAuth**, no scoped tokens and no app
 * registration. Every tool that reads a private favourites folder — yt-dlp
 * included — authenticates with `SESSDATA`, a session cookie that *is* the
 * account. `docs/bilibili.md` §6.1 has the table; the short version is that
 * unlike #106's `youtube.readonly`, this credential has no scope, no per-app
 * revocation, and a leak costs posting, commenting and purchase history rather
 * than "someone read your playlists".
 *
 * That is why the answer is the flow **Bilibili's own TV and device apps use**:
 * we show a QR code, the user confirms in the official app, and the credential
 * arrives the way their own devices get it. MiO never sees a password and there
 * is no login form of ours to phish.
 *
 * ## The non-negotiables, from §6.1
 *
 * - **Device only. Never the droplet.** A `SESSDATA` on the server would be one
 *   file granting full access to a real account, and it contradicts #159 and
 *   #246 outright. Nothing here has a server side.
 * - **`SecureStore`**, as the install id and access key already are.
 * - **Never in diagnostics.** `scrub()` exists because prose did not stop song
 *   titles being uploaded (#354); a credential is a new class and gets its own
 *   test rather than an assumption that the existing filter covers it.
 * - **Store only what a read needs.** Login also returns `bili_jct`, the CSRF
 *   token for **writes**. Measured 2026-08-14 against a real account: a private
 *   folder reads back with `SESSDATA` alone, so `bili_jct` is **discarded** and
 *   a leaked store cannot post as the user.
 * - **A visible disconnect that actually clears it**, like #106's.
 * - **Expiry says "sign in again"**, never "this list is private" — the two are
 *   different failures asking for opposite actions, which is the trap that cost
 *   #106 a whole class of weekly confusion.
 *
 * ## What was measured
 *
 * Both endpoints, 2026-08-14, unauthenticated so they needed no account:
 *
 *     generate → code 0, data.url = https://account.bilibili.com/h5/…scan-web?…
 *     poll     → code 0, data: { url: "", refresh_token: "", code: 86101 }
 *
 * ⚠️ **And the success payload, 2026-08-15 — which is the one this file first
 * guessed, and guessed wrong.** See {@link pollQrLogin}: the credential is in
 * `Set-Cookie`, and `data.url` carries only a `ticket`. A code also expires
 * after **~160 s**, not the 180 assumed elsewhere.
 *
 * ⚠️ **The outer `code` is `0` while the login has not happened.** The status is
 * `data.code`. Branching on the outer one would read "not scanned yet" as a
 * completed login — and on this API `code: 0` means "I parsed your request"
 * rather than "here is your answer", which the same day cost three empty
 * measurements that all looked like successes.
 */

/** Alphanumeric plus `._-`; SecureStore rejects anything else. */
const SESSDATA_KEY = 'mio_bilibili_sessdata'
const USER_ID_KEY = 'mio_bilibili_user_id'

const PASSPORT = 'https://passport.bilibili.com/x/passport-login/web/qrcode'

/**
 * The same browser shape every other Bilibili request here carries.
 *
 * Not shared with `bilibili.ts` because these calls must **not** send `buvid3`:
 * that cookie is the anti-crawl workaround for the API host, and passport is a
 * different host with a different contract. Sending an invented cookie into a
 * login flow is the kind of thing that works until it does not.
 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

const REQUEST_TIMEOUT_MS = 15_000

/** Bilibili's own `data.code` values for the poll. */
const WAITING = 86101
const SCANNED = 86090
const EXPIRED = 86038

/**
 * A dead or missing session, told apart from a refusal.
 *
 * ⚠️ **This is the whole of the "expiry says sign in again" rule.** Bilibili
 * answers `-101` for "not logged in" and `-403` for "not yours"; they ask for
 * opposite actions, and there is no refresh token, so a `SESSDATA` simply stops
 * working one day. Collapsing the two would make a routine expiry read as "this
 * folder is private", which is the shape of #106's weekly confusion.
 */
export class BilibiliSignedOut extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BilibiliSignedOut'
  }
}

/** Bilibili's `-101`: the request carried no usable session. */
export const NOT_LOGGED_IN = -101

/**
 * Cached after the first read, because the request path needs it
 * **synchronously** and SecureStore is async — the same reason `installId`
 * keeps one. `null` means "no credential"; `undefined` means "not loaded yet".
 */
let cached: BilibiliCredential | null | undefined

export type BilibiliCredential = {
  sessdata: string
  /** `DedeUserID`. Needed to list *your* folders — `up_mid` is a query
   *  parameter, not something the cookie implies. Not secret. */
  userId: string
}

/** Whether a credential is held, as something React can re-render on. */
export const useBilibiliAccount = create<{ signedIn: boolean; userId: string | null }>(() => ({
  signedIn: false,
  userId: null,
}))

function publish(credential: BilibiliCredential | null): void {
  cached = credential
  useBilibiliAccount.setState({
    signedIn: credential !== null,
    userId: credential?.userId ?? null,
  })
}

/** The credential, or null. Reads SecureStore once, then the cache. */
export async function loadBilibiliCredential(): Promise<BilibiliCredential | null> {
  if (cached !== undefined) return cached

  const [sessdata, userId] = await Promise.all([
    SecureStore.getItemAsync(SESSDATA_KEY),
    SecureStore.getItemAsync(USER_ID_KEY),
  ])
  // Both or neither: half a credential cannot read anything and would fail as
  // "signed in but refused", which is the confusing shape this file exists to
  // avoid.
  publish(sessdata && userId ? { sessdata, userId } : null)
  return cached ?? null
}

export async function saveBilibiliCredential(credential: BilibiliCredential): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(SESSDATA_KEY, credential.sessdata),
    SecureStore.setItemAsync(USER_ID_KEY, credential.userId),
  ])
  publish(credential)
}

/**
 * Forget it, everywhere.
 *
 * The cache is cleared *first* so nothing can read a stale value while the two
 * SecureStore deletes are in flight — a disconnect that leaves the credential
 * live for another few hundred milliseconds is not a disconnect.
 */
export async function clearBilibiliCredential(): Promise<void> {
  publish(null)
  await Promise.all([
    SecureStore.deleteItemAsync(SESSDATA_KEY),
    SecureStore.deleteItemAsync(USER_ID_KEY),
  ])
}

/**
 * The `SESSDATA` for the request path, synchronously, or null.
 *
 * Returns null before {@link loadBilibiliCredential} has run rather than
 * blocking: an anonymous request is exactly what the public path already does,
 * so the cost of being early is reading public folders only, not an error.
 */
export function currentSessdata(): string | null {
  return cached?.sessdata ?? null
}

/** Test seam — module state outlives a test file otherwise. */
export function resetBilibiliAuthForTests(): void {
  cached = undefined
  useBilibiliAccount.setState({ signedIn: false, userId: null })
}

async function passportFetch(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Referer: REFERER },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export type QrSession = {
  /** What the QR code encodes. An ordinary https URL — measured, there is no
   *  `bilibili://` scheme to deep-link with. */
  url: string
  qrcodeKey: string
}

/** Ask for a QR code. */
export async function startQrLogin(): Promise<QrSession> {
  const response = await passportFetch(`${PASSPORT}/generate`)
  const body = (await response.json()) as {
    code?: number
    data?: { url?: string; qrcode_key?: string }
  }

  const url = body.data?.url
  const key = body.data?.qrcode_key
  if (body.code !== 0 || !url || !key) {
    throw new Error(`Bilibili would not start a login (code ${body.code ?? 'none'})`)
  }
  return { url, qrcodeKey: key }
}

export type QrStatus =
  | { state: 'waiting' }
  | { state: 'scanned' }
  | { state: 'expired' }
  | { state: 'done'; credential: BilibiliCredential; via: CredentialSource }

/**
 * Where the login has got to.
 *
 * ⚠️ **Read `data.code`, never the outer one**, which is `0` throughout.
 *
 * ## The credential comes out of `Set-Cookie`, not out of `data.url`
 *
 * This file used to say the opposite, and it was the one thing here nobody had
 * measured — a real scan from a real account was needed, and #533 shipped
 * without one. **Measured 2026-08-15**, twice, by driving a scan through the
 * phone's own Bilibili app:
 *
 *     data.url  = https://passport.biligame.com/x/passport-login/web/crossDomain
 *                 ?ticket=…&gourl=…&first_domain=…
 *     Set-Cookie: SESSDATA, bili_jct, DedeUserID, DedeUserID__ckMd5, sid
 *
 * So the hand-off URL carries a **`ticket`** and no credential at all. The
 * old reader found no `SESSDATA`, threw, and — because the confirmed key is
 * spent the moment it is read — the *next* poll two seconds later answered
 * `86038`, so the screen said "the code expired". I saw that four or five
 * times in a row on 2026-08-15 and it was never an expiry: the login could not
 * have succeeded on any phone at any speed.
 *
 * ⚠️ **The query string is still read, as a fallback.** Bilibili has now
 * changed this shape once, unannounced, and preferring cookies while still
 * accepting the documented form costs four lines and means the next change has
 * to break *both* to break the login.
 *
 * ## Why reading a response header is not obviously safe here
 *
 * React Native's `fetch` is backed by OkHttp, which keeps its own cookie jar —
 * whether a `Set-Cookie` survives to JavaScript is exactly the risk §8 lists,
 * and it is **not** answerable from a laptop. That is what
 * `bilibili.qr.credentialFrom` is in the log for: the phone says which of the
 * two routes produced the credential, so this is settled by the device rather
 * than by argument.
 *
 * `bili_jct` is in there too and is deliberately **not** read: it is the token
 * for *writes*, a private folder reads back without it, and a store that cannot
 * post is a store worth leaking less.
 */
export async function pollQrLogin(qrcodeKey: string): Promise<QrStatus> {
  const response = await passportFetch(
    `${PASSPORT}/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
  )
  const body = (await response.json()) as {
    data?: { code?: number; url?: string }
  }

  const code = body.data?.code
  if (code === WAITING) return { state: 'waiting' }
  if (code === SCANNED) return { state: 'scanned' }
  if (code === EXPIRED) return { state: 'expired' }
  if (code !== 0) throw new Error(`Bilibili login answered ${code ?? 'nothing'}`)

  const handoff = body.data?.url ?? ''
  const cookies = setCookieHeader(response.headers)

  const found = credentialFrom(handoff, cookies)
  if (!found) throw new BilibiliHandoffUnreadable(handoff, cookies)
  return { state: 'done', credential: found.credential, via: found.via }
}

/**
 * Every `Set-Cookie` on a response, as one string.
 *
 * Three shapes, because this is the piece that differs between the runtimes.
 * `getSetCookie()` is the correct one and Node has it; React Native's `Headers`
 * may only offer `get`, which joins repeats with `, `. Joining is lossy in
 * general — a cookie's `Expires` attribute contains a comma — but it does not
 * matter here, because {@link cookieValue} anchors on the cookie's *name* and
 * stops at the first delimiter, and both values wanted are percent-encoded.
 */
function setCookieHeader(headers: Headers): string {
  const all = (headers as { getSetCookie?: () => string[] }).getSetCookie?.()
  if (all && all.length > 0) return all.join('\n')
  return headers.get('set-cookie') ?? ''
}

/**
 * One cookie's value out of a `Set-Cookie` blob.
 *
 * Anchored on a name at a boundary so `DedeUserID` cannot match inside
 * `DedeUserID__ckMd5`, and stopped at the first `;`, `,`, whitespace or
 * newline. Measured: `SESSDATA` is percent-encoded and `DedeUserID` is digits,
 * so neither can contain a delimiter.
 */
function cookieValue(blob: string, name: string): string | null {
  const match = new RegExp(`(?:^|[;,\\s])${name}=([^;,\\s]+)`).exec(blob)
  return match ? decode(match[1]) : null
}

/**
 * Confirmed by the user, and still unreadable.
 *
 * ⚠️ **This is the one branch nobody could measure** — it needs a real scan from
 * a real account — so if the login ever fails, this is where to look. It is a
 * *typed* error rather than a bare one because the caller has to be able to
 * write down what arrived, and this module deliberately does no logging of its
 * own: `bilibiliCredentialNeverLogged.test.ts` asserts that, on the grounds
 * that `scrub()` is a net and not a policy, and the file that holds the
 * credential should not be relying on a net.
 *
 * So the shape travels out and the screen records it. What it carries is safe
 * by construction: a **length**, which cannot be replayed, and the parameter
 * **names**, which are fixed vocabulary. Never a value.
 */
export class BilibiliHandoffUnreadable extends Error {
  readonly handoffLength: number
  readonly keys: string[]
  /** The cookie *names* the response set, which is how the 2026-08-15 change
   *  would have been visible in one line instead of a day. */
  readonly cookies: string[]

  constructor(handoff: string, setCookie = '') {
    super('Bilibili confirmed the login but returned no session')
    this.name = 'BilibiliHandoffUnreadable'
    this.handoffLength = handoff.length
    this.keys = [...parseQuery(handoff).keys()]
    this.cookies = cookieNames(setCookie)
  }

  /** The one line worth logging, and nothing that identifies the account. */
  describe(): string {
    return `handoffLength=${this.handoffLength} keys=[${this.keys.join(' ')}] cookies=[${this.cookies.join(' ')}]`
  }
}

/** The names in a `Set-Cookie` blob. Names are fixed vocabulary; values are the
 *  account, so only the names ever leave this file. */
function cookieNames(blob: string): string[] {
  const names: string[] = []
  for (const part of blob.split(/[\n,]/)) {
    const name = /^\s*([A-Za-z0-9_]+)=/.exec(part)?.[1]
    // Cookie *attributes* (`Path`, `Expires`, `Max-Age`, …) follow a `;`, so
    // only the first pair of each line is a cookie name.
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

/** Which of the two routes a credential actually arrived by. Logged, so the
 *  phone settles what a laptop cannot check. */
export type CredentialSource = 'cookie' | 'query'

/**
 * Pull `SESSDATA` and `DedeUserID` out of a confirmed login.
 *
 * **Cookies first** — measured 2026-08-15 as the only place they are actually
 * sent — then the hand-off URL's query string, which is where this used to look
 * and where Bilibili's own documentation still says they are.
 *
 * Exported for its own test: this is the one piece of parsing between a
 * confirmed scan and a working account, and a device is a slow way to find out
 * it is wrong. It got found out the slow way once already.
 */
export function credentialFrom(
  url: string,
  setCookie = '',
): { credential: BilibiliCredential; via: CredentialSource } | null {
  const fromCookies = pair(cookieValue(setCookie, 'SESSDATA'), cookieValue(setCookie, 'DedeUserID'))
  if (fromCookies) return { credential: fromCookies, via: 'cookie' }

  const params = parseQuery(url)
  // Deliberately not `bili_jct`, which is in both — see the header.
  const fromQuery = pair(params.get('SESSDATA'), params.get('DedeUserID'))
  return fromQuery ? { credential: fromQuery, via: 'query' } : null
}

/** Both or neither: half a credential reads nothing and fails as "signed in but
 *  refused", which is the confusing shape this file exists to avoid. */
function pair(
  sessdata: string | null | undefined,
  userId: string | null | undefined,
): BilibiliCredential | null {
  return sessdata && userId ? { sessdata, userId } : null
}

/**
 * Split a URL's query string by hand, rather than with `URLSearchParams`.
 *
 * ⚠️ **`URLSearchParams` is not the same object in jest and on the phone**, and
 * this is exactly the trap `docs/lessons.md` names as "a test environment that
 * supplies an API the runtime lacks". Hermes ships no `URLSearchParams`, so
 * React Native polyfills one (`Libraries/Blob/URLSearchParams.js`), and its
 * parser is:
 *
 *     const [key, value] = pair.split('=').map(decodeURIComponent)
 *
 * `split('=')` on `SESSDATA=abc=` yields three parts and the destructure keeps
 * two, so **a value containing an unencoded `=` is silently truncated**. Node's
 * — which is what jest runs — keeps everything after the first `=`. Measured
 * 2026-08-15:
 *
 *     'SESSDATA=abc,def,CjB1eQ=='  node → 'abc,def,CjB1eQ=='
 *                                  RN   → 'abc,def,CjB1eQ'
 *
 * A truncated `SESSDATA` is the worst possible failure here: it stores, the
 * screen says signed in, and every folder read then answers `-101`, which the
 * UI honestly reports as "sign in again". Splitting at the *first* `=` only is
 * what both the spec and Node do, and it is four lines.
 */
function parseQuery(url: string): Map<string, string> {
  const found = new Map<string, string>()
  const start = url.indexOf('?')
  if (start === -1) return found

  for (const pair of url.slice(start + 1).split('&')) {
    if (!pair) continue
    const split = pair.indexOf('=')
    if (split === -1) continue
    const key = decode(pair.slice(0, split))
    // First one wins, matching `URLSearchParams.get`, which returns the first
    // of a repeated key rather than the last.
    if (!found.has(key)) found.set(key, decode(pair.slice(split + 1)))
  }
  return found
}

/** `decodeURIComponent` throws on a stray `%`, and a login is not the place to
 *  discover that. A value we cannot decode is better than no login at all. */
function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '))
  } catch {
    return part
  }
}
