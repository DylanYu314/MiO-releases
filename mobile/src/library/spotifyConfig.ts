/**
 * The Spotify application this build signs in to (#612).
 *
 * ## Why these are plain constants and not `app.json`
 *
 * ⚠️ **Measured**: adding `extra.spotifyClientId` to `app.json` changes the
 * `expoConfig` fingerprint source, so it would force a native build and block
 * every pending JS update behind one. This file is ordinary JavaScript and
 * hashes to nothing, so the whole Spotify wave ships over the air.
 *
 * ## A client id is not a secret
 *
 * It appears in the authorize URL every user can read, and the flow is PKCE —
 * which exists precisely so a public client needs no secret. Committing it is
 * correct, and it stays correct when this repository goes public.
 *
 * ⚠️ **The `client_secret` must never appear here.** The backend does not use
 * one either (`app/spotify.py`'s `exchange_code` takes none); if a future
 * change seems to need one, the flow has been changed into a confidential one
 * by mistake.
 *
 * ## Two things must match Spotify's dashboard, or sign-in fails at the door
 *
 * 1. **`SPOTIFY_CLIENT_ID`** — from the app's dashboard page.
 * 2. **`SPOTIFY_REDIRECT_URI`** — must be registered there **exactly**.
 *    `mio://add/import` is the app's own scheme (`app.json`'s `"scheme": "mio"`)
 *    and resolves to `app/(tabs)/add/import/index.tsx`, because expo-router
 *    does not treat route groups as path segments. The backend has been
 *    redirecting here since Spotify import shipped, so the app already handles
 *    it — what is new is that **Spotify** sends it rather than the server.
 *
 * ⚠️ Spotify rejects the hostname `localhost` outright and has changed its
 * redirect-URI rules before. Check the dashboard rather than this comment if it
 * refuses.
 */

/**
 * ⚠️ **Annotated `: string`, not left to inference.** Without it TypeScript
 * narrows the constant to its own literal, and every `=== ''` check elsewhere
 * becomes a compile error the moment a real id is filled in — which is exactly
 * when it must still compile.
 *
 * Empty until it is filled in.
 *
 * Deliberately not a placeholder string that looks real: an empty value makes
 * `beginSignIn` refuse with a message naming the problem, where a fake id would
 * send the user to Spotify and come back with an opaque `invalid_client`.
 */
export const SPOTIFY_CLIENT_ID: string = 'f32b5b14d8174f4ba0f8d336341524b4'

export const SPOTIFY_REDIRECT_URI: string = 'mio://add/import'

/** Whether this build can sign in at all — the Spotify section hides itself
 *  rather than offering a button that cannot work. */
export function spotifyConfigured(): boolean {
  return SPOTIFY_CLIENT_ID.length > 0
}
