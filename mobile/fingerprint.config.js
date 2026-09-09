/**
 * Fingerprint inputs, so the runtime version EAS computes matches the one this
 * machine computes.
 *
 * ## Why this file exists
 *
 * `app.json` sets `runtimeVersion: { policy: "fingerprint" }`. EAS calculates
 * that fingerprint **after** `expo prebuild` has run on the builder; the local
 * machine calculates it **before**, from a managed checkout with no `android/`
 * at all. Anything prebuild changes therefore diverges, and `expo-updates`
 * fails the build rather than ship a binary whose updates could never reach it.
 *
 * The build on 2026-08-13 died exactly there, in `CONFIGURE_EXPO_UPDATES`:
 *
 *     local  e1c3b2f9df30f45e68211474b3670248ae1d631d
 *     EAS    e75c69f51d24336392d28fb78bbb44d63633a8a7
 *
 *     added    android                       (bareNativeDir)
 *     changed  node_modules/expo-audio/android
 *                34ab787d… → d56b9908…
 *
 * Both are ours and both are expected:
 *
 * - **`android/`** is prebuild's output. It is gitignored and does not exist in
 *   a managed checkout, so only EAS ever sees it.
 * - **`node_modules/expo-audio/android`** is rewritten at prebuild by
 *   `plugins/withSinglePlayerMediaSession.js` (#473) and
 *   `plugins/withMonoAudioProcessor.js` (#482). That is the whole point of
 *   those plugins — and it means expo-audio's native source on the builder is
 *   *supposed* to differ from the pristine copy in `node_modules` here.
 *
 * This was the **first build attempted since those plugins landed**, which is
 * why it had never bitten before. It is not transient and a retry cannot fix it.
 *
 * ## Why ignoring them is safe
 *
 * Ignoring an input means a change to it no longer bumps the runtime version —
 * which, wrongly done, ships an over-the-air update to a binary that lacks the
 * native code it calls (#418's failure with worse consequences). Both holes are
 * closed by something else already hashing the same change:
 *
 * - **A change to what the plugins inject** is caught by `extraSources` below.
 *   `plugins/kotlin/*.kt` is read by the plugin at runtime rather than
 *   `require`d, so fingerprint does not discover it on its own — it has to be
 *   named. That is the important half of this file, not the ignores.
 * - **An `expo-audio` version bump** is caught by
 *   `node_modules/expo-audio/package.json`, which is hashed in its own right
 *   under `expoConfigPlugins` — verified in the source list, not assumed.
 *
 * So the only thing made invisible is prebuild's own deterministic output.
 *
 * ⚠️ **The root `package.json` is *not* a fingerprint source**, contrary to what
 * this repo's conventions and `docs/native-rebuild.md` said. Measured 2026-08-13: adding a
 * dependency *and* an `expo.install.exclude` block left the hash at
 * `6f0b0074…`. What actually moves the fingerprint is the resolved **native
 * module set** and each native package's own files — so adding a dependency
 * that pulls in a *new* native module does bump it, while declaring one that
 * was already installed does not. Do not rely on "I touched package.json" as a
 * reason a runtime version changed.
 */

module.exports = {
  ignorePaths: [
    // Prebuild's output. Present on the builder, absent here, identical in
    // meaning to the config it is generated from — which is hashed.
    'android/**/*',
    // Rewritten at prebuild by the two config plugins below. See above for why
    // this cannot simply be left in.
    'node_modules/expo-audio/android/**/*',
  ],

  extraSources: [
    {
      type: 'dir',
      filePath: 'plugins',
      reasons: ['mio-config-plugins'],
    },
  ],
}
