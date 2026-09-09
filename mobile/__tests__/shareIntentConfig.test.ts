import appConfig from '../app.json'

/**
 * The Android share target is declared, and declared correctly (#573).
 *
 * ## Why this is a test and not a comment
 *
 * Because the manifest is *generated*. `app.json`'s `android.intentFilters` is
 * rendered into `AndroidManifest.xml` by `expo prebuild`, so a typo here does
 * not fail anything — it produces an app that simply never appears in the share
 * sheet, and the only way to find out is to build it and try. That is the #561
 * shape again: the ingredient exists and the wiring is what is missing.
 *
 * The rendering was verified against `@expo/config-plugins`'s own
 * `renderIntentFilters` rather than assumed, which is what confirmed that
 * `action: 'SEND'` becomes `android.intent.action.SEND` and that arbitrary
 * `data` keys become `android:*` attributes.
 */

const filters = appConfig.expo.android.intentFilters ?? []

it('declares an ACTION_SEND filter', () => {
  // `action` is rendered as `android.intent.action.${action}`, so the bare verb
  // is correct here and a fully-qualified one would produce a filter for
  // `android.intent.action.android.intent.action.SEND`.
  expect(filters.some((filter) => filter.action === 'SEND')).toBe(true)
})

it('accepts text of any kind, and only text', () => {
  /*
   * `text/*` rather than `text/plain`, measured on the device 2026-08-17: 128
   * activities accept a `text/plain` share and **70 accept `text/html`**, so a
   * link arriving as rich text is a real pattern. Matching only `text/plain`
   * would drop those silently — MiO would not appear in the sheet, with nothing
   * anywhere to say why.
   *
   * ⚠️ **And still not a wildcard, nor video.** I asked whether sharing a
   * *video* was handled: it is, because what a video app shares is a **URL
   * string**, which is text. A video *file* share is `video/mp4` with a content
   * URI in `EXTRA_STREAM`, and on this phone its receivers are the file
   * manager, the cloud drive, Bluetooth and email — file destinations. MiO has
   * nothing to do with those, and claiming them would put it in the sheet for
   * something it cannot handle.
   */
  const send = filters.find((filter) => filter.action === 'SEND')
  expect(send?.data).toEqual([{ mimeType: 'text/*' }])
})

it('does not claim video or audio files', () => {
  // The half that keeps the entry honest. A share-sheet entry that then does
  // the wrong thing is worse than no entry, and `add/local.tsx` is where an
  // audio *file* belongs.
  const send = filters.find((filter) => filter.action === 'SEND')
  const types = (send?.data ?? []).map((datum) => datum.mimeType)
  expect(types.some((type) => type?.startsWith('video/') || type?.startsWith('audio/'))).toBe(false)
  expect(types).not.toContain('*/*')
})

it('is in the DEFAULT category, or Android will not offer it', () => {
  // A filter with no category is not matched by an implicit intent, which is
  // exactly what a share is. Without this the app is invisible in the sheet and
  // nothing anywhere says why.
  const send = filters.find((filter) => filter.action === 'SEND')
  expect(send?.category).toContain('DEFAULT')
})
