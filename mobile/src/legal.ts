/**
 * Where MiO's published policy lives (#513).
 *
 * The privacy policy is a static page on `mio.dlany.uk`, not a screen in the
 * app. That is deliberate: the policy has to be readable by someone deciding
 * whether to *install* MiO — before the app exists on their phone — so the web
 * page is the canonical copy and the app links to it rather than shipping a
 * second version that can drift from it.
 *
 * ⚠️ **The trailing slash is the canonical form, and both were measured**
 * (2026-09-03): `/privacy/` and `/privacy` each answer 200 with
 * `<title>MiO — Privacy</title>`, because Caddy redirects the bare path. That
 * check is not paranoia — #517 cost a day to *a directory is not a file*, where
 * `try_files {path} /index.html` served the React app for `/download/` instead
 * of the static page, with a 200 and no error anywhere.
 */
export const PRIVACY_URL = 'https://mio.dlany.uk/privacy/'
