const path = require('path')

const { getDefaultConfig } = require('expo/metro-config')

/**
 * Metro has to be told that `shared/` exists.
 *
 * `@mio/shared` is a `file:../shared` dependency, so npm symlinks it into
 * `node_modules/@mio/`. Node and jest follow that symlink without help, which is
 * why the test suite has never noticed a problem. **Metro does not.** Its watched
 * set defaults to the project root alone, and `shared/` is outside it.
 *
 * The failure mode is nasty because it is invisible until it isn't:
 *
 * - Files that existed when Metro first crawled resolve fine forever. `tokens.ts`
 *   and the i18n catalogues have worked since P2 for that reason alone.
 * - A **new** file in `shared/` does not exist as far as a running dev server is
 *   concerned. P8 added `shared/loudness.ts` and the app stopped opening with
 *   `Unable to resolve "@mio/shared/loudness"` — on a bundle that builds
 *   perfectly from cold.
 * - Worse and quieter: an **edited** shared file may not trigger a reload, so a
 *   stale copy keeps being served. Every i18n string added to `shared/i18n`
 *   carried that risk.
 *
 * `npx expo start --clear` works around all of it and explains none of it, which
 * is how this stayed hidden. `expo export` also succeeds, so CI's `npm run build`
 * cannot catch it — the artefact is correct; only the watcher was wrong.
 */
const config = getDefaultConfig(__dirname)

config.watchFolders = [path.resolve(__dirname, '..', 'shared')]

module.exports = config
