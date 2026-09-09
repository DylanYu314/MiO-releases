import { logInfo } from './log'

/**
 * What this JavaScript runtime actually provides, recorded once per launch.
 *
 * ## Why this exists
 *
 * **Hermes is not Node, and jest is Node.** This project has now been bitten by
 * that three times, each time expensively and each time invisibly:
 *
 * - `crypto.getRandomValues` — assumed present, absent under Hermes. Minting an
 *   install id threw on every launch that needed one, so every write answered
 *   400. Green suite throughout, because Node has `globalThis.crypto` (#188).
 * - `TextDecoder` — jest has it, Hermes does not, which is why
 *   `audioTags.ts` is hand-rolled and `src/polyfills/textEncoder` exists.
 * - `Intl.PluralRules` — Node's `Intl` is complete, Hermes gives i18next none,
 *   so its `dummyRule` applied English's plural shape to Chinese and 29 strings
 *   fell back to English at a count of 1 (#557).
 *
 * In every case a test on Node **passed against the broken app**. The pattern is
 * not "we keep forgetting"; it is that the environment which could tell us is
 * the one place we never look. So the app tells us, from the device, once.
 *
 * `String.prototype.normalize` was the open one when this was written (#609):
 * `matching.ts` needs it to fold accents and full-width text the way
 * `matching.py` does. This probe is what answered it — see below.
 *
 * ## Written to two places, and ⚠️ only one of them works in a release build
 *
 * `logInfo` puts it on the diagnostics screen and in the daily upload. That is
 * the one that works; read it at Settings → 诊断.
 *
 * ⚠️ **`console.info` does *not* reach `adb logcat` in a release build.**
 * Measured 2026-08-19: this line was published, the app relaunched onto it, and
 * `logcat` carried **zero** `ReactNativeJS` lines while the diagnostics screen
 * showed the entry. So the console call is `__DEV__`-only — do not go looking
 * for it in logcat on a production APK and conclude from the silence that the
 * probe did not run.
 *
 * ⚠️ **This measures the runtime *the app sees*, after polyfills.**
 * `textDecoder` reads `true` because `src/polyfills/textEncoder` supplies it,
 * not because Hermes does. That is the useful question — what the code can
 * actually call — but it is not a statement about the engine.
 *
 * ## What it answered, 2026-08-19, on a real device
 *
 * `normalize=true intlPluralRules=false textDecoder=true webCrypto=false
 * intlSegmenter=false` — versionCode 24, Hermes, RMX3301.
 *
 * So **Hermes does have `String.prototype.normalize`**, which closes #609's one
 * open assumption: `matching.ts` folds exactly as `matching.py` does. And the
 * two already-documented gaps came back as documented — `intlPluralRules=false`
 * is #557, `webCrypto=false` is #188 — which is what makes the first reading
 * trustworthy rather than merely convenient.
 */
export interface RuntimeCapabilities {
  normalize: boolean
  intlPluralRules: boolean
  textDecoder: boolean
  webCrypto: boolean
  intlSegmenter: boolean
}

export function detectCapabilities(): RuntimeCapabilities {
  const intl = (globalThis as { Intl?: Record<string, unknown> }).Intl
  return {
    normalize: typeof String.prototype.normalize === 'function',
    intlPluralRules: typeof intl?.PluralRules === 'function',
    // Read off `globalThis` rather than the bare name: a bare reference to a
    // missing global is a ReferenceError, not `undefined`, which would make the
    // probe crash exactly where it is most needed.
    textDecoder: typeof (globalThis as { TextDecoder?: unknown }).TextDecoder !== 'undefined',
    webCrypto:
      typeof (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto?.getRandomValues ===
      'function',
    intlSegmenter: typeof intl?.Segmenter === 'function',
  }
}

let reported = false

/**
 * Record the runtime's capabilities, once.
 *
 * Unconditional — it logs the *whole* set whether or not anything is missing.
 * A line that only appears on failure cannot be told apart from a probe that
 * never ran, which is the mistake #371's `running=false` made: an instrument
 * that cannot produce the other answer has measured nothing.
 */
export function reportCapabilities(): RuntimeCapabilities {
  const capabilities = detectCapabilities()
  if (!reported) {
    reported = true
    const summary = Object.entries(capabilities)
      .map(([name, present]) => `${name}=${present}`)
      .join(' ')
    logInfo('runtime.capabilities', summary)
    // Dev only, because a release build does not forward console to logcat at
    // all — measured, see the docblock. Printing it there would be noise that
    // nobody can read.
    if (__DEV__) console.info(`[mio] runtime.capabilities ${summary}`)
  }
  return capabilities
}

/** Test seam: the once-only flag is module state and outlives a test. */
export function __resetCapabilities(): void {
  reported = false
}
