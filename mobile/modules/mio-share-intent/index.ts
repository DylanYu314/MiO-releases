import { requireOptionalNativeModule } from 'expo'

/**
 * Text shared into MiO from another app (#573).
 *
 * **`requireOptionalNativeModule`, not `requireNativeModule`.** Kotlin only
 * exists in a binary built after it was added, and the app must keep running in
 * one that was not — the same reasoning as `mio-equalizer` and
 * `mio-foreground-task`, and the same failure the `playbackRate` crash taught
 * this project to avoid. An absent module means no shares arrive and everything
 * else behaves exactly as it did before this landed.
 *
 * ## Why the parsing is not here
 *
 * A share is a *sentence*, and turning it into a link is `linkText.ts` —
 * JavaScript, so it ships over the air (#412). This module's whole job is to
 * hand over a string Android will not otherwise let JavaScript see.
 */
interface MioShareIntentNative {
  /** The text the app was launched with, once. Null when it was not launched by
   *  a share, and null on every call after the first. */
  consumePending(): string | null
  addListener(event: 'onShare', listener: (payload: { text: string }) => void): { remove(): void }
}

const native = requireOptionalNativeModule<MioShareIntentNative>('MioShareIntent')

/** True in a binary built with this module. False everywhere else, and callers
 *  must behave as though no share will ever arrive. */
export const shareIntentSupported = native !== null

/**
 * The share that launched the app, if any — and only the first time.
 *
 * Consuming rather than reading, because Android keeps the launch intent for the
 * life of the activity: a getter would hand back the same link on every remount
 * and ask the user to import it again each time.
 */
export function consumePendingShare(): string | null {
  try {
    return native?.consumePending() ?? null
  } catch {
    // Losing a share is bad; losing the screen that was mounting is worse.
    return null
  }
}

/** Shares that arrive while the app is already running, which is the common
 *  case. Returns a no-op unsubscribe when the module is absent. */
export function onShare(listener: (text: string) => void): () => void {
  if (!native) return () => {}
  const subscription = native.addListener('onShare', ({ text }) => listener(text))
  return () => subscription.remove()
}
