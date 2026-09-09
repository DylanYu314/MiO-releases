package dev.dylanyu.mio.shareintent

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The text another app shared into MiO (#573).
 *
 * ## Why this needs Kotlin at all
 *
 * Android delivers a share as `ACTION_SEND` with the text in
 * `Intent.EXTRA_TEXT` — an **extra**, not the intent's data. `expo-linking` and
 * React Native's `Linking` both read `getIntent().getData()`, so neither can
 * see it, and there is no JavaScript route to an extra. That is the whole
 * reason this module exists; the parsing of the text is `linkText.ts` and stays
 * in JavaScript, where it ships over the air.
 *
 * ## Two arrivals, and both matter
 *
 * A share reaches a **cold** app as the launch intent, and a **warm** one
 * through `onNewIntent` — the ordinary case, since MiO is likely already open
 * in the background when someone shares to it. {@link consumePending} covers
 * the first and the `onShare` event covers the second.
 *
 * ## Consumed, not read
 *
 * `consumePending` clears the extra after handing it over, and that is
 * deliberate. Android keeps the launch intent for the life of the activity, so
 * a plain getter would return the same shared link again on every remount — a
 * rotation, a tab switch, coming back from another screen — and the user would
 * be asked to import the same thing repeatedly with no way to say no
 * permanently.
 *
 * ## Failure is never fatal
 *
 * Every path answers a value rather than throwing, the same trade
 * `mio-media-session` and `mio-foreground-task` both record: losing a share is
 * bad, and losing the app because a share could not be read would be worse.
 */
class MioShareIntentModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MioShareIntent")

    // Fired when a share arrives at an app that is already running, which is
    // the common case rather than the edge one.
    Events("onShare")

    /**
     * The text this app was launched with, once.
     *
     * Null when the app was not launched by a share — the ordinary case, and
     * not an error.
     */
    Function("consumePending") {
      val activity = appContext.currentActivity ?: return@Function null
      val intent = activity.intent ?: return@Function null
      val text = sharedTextOf(intent)
      if (text != null) {
        // Cleared so a remount does not read it a second time. Removing the
        // extra rather than replacing the intent: the intent carries the
        // launch information the rest of the app may still want.
        intent.removeExtra(Intent.EXTRA_TEXT)
      }
      text
    }

    OnNewIntent { intent ->
      val text = sharedTextOf(intent)
      if (text != null) {
        intent.removeExtra(Intent.EXTRA_TEXT)
        sendEvent("onShare", mapOf("text" to text))
      }
    }
  }

  /**
   * The shared text, or null.
   *
   * ## Any `text/` subtype, not only `text/plain`
   *
   * ⚠️ **The mime globs below are spelled out in words on purpose.**
   * Kotlin block comments **nest**, so a literal slash-star inside this KDoc
   * opens a comment that the closing delimiter then does not balance — which
   * silently swallows every declaration after it. That is not hypothetical:
   * it is why this file did not compile the first time it was ever built.
   *
   * Measured on the device, 2026-08-17: 128 activities accept a `text/plain`
   * share and **70 accept `text/html`**, so a link arriving as rich text is a
   * real pattern rather than a hypothetical one. Matching only `text/plain`
   * would drop those silently — the app would simply not appear in the sheet,
   * with nothing anywhere to say why.
   *
   * ⚠️ **And a `text/` prefix is still not a full wildcard.** A video *file* share is
   * `video/mp4` with a content URI in `EXTRA_STREAM`, and its receivers on this
   * phone are the file manager, the cloud drive, Bluetooth and email — file
   * destinations. MiO has nothing to do with those. What YouTube, Bilibili and
   * Instagram send when they "share a video" is a **URL string**, which is
   * text, which is this.
   *
   * `ACTION_SEND` only. `ACTION_SEND_MULTIPLE` is not accepted and is not
   * declared in the manifest either — several links at once is a different
   * question with a different answer, and half-supporting it would mean
   * silently importing one of them.
   */
  private fun sharedTextOf(intent: Intent): String? {
    if (intent.action != Intent.ACTION_SEND) return null
    if (intent.type?.startsWith("text/") != true) return null
    return intent.getStringExtra(Intent.EXTRA_TEXT)?.takeIf { it.isNotBlank() }
  }
}
