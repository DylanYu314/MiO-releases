import fs from 'node:fs'
import path from 'node:path'

/**
 * Over-the-air updates, and the three ways to configure them wrong (#412).
 *
 * Every JavaScript-only fix used to need a full production APK — twenty minutes
 * of cloud build for a one-line change, which is why this exists at all. What
 * makes it *safe* rather than merely fast is the runtime version: a bundle may
 * only be served to a binary whose native side it actually matches.
 *
 * All three checks below fail silently in the worst possible way. A wrong URL
 * means updates never arrive and nobody is told; a missing channel means a build
 * profile receives none; and the wrong runtime policy means a bundle is served
 * to a binary that cannot run it. So they are read from the config the way
 * `nativeModuleConfig.test.ts` reads `modules/` — a checklist in a doc is what
 * three cloud builds died on.
 */

const app = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8')).expo
const eas = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eas.json'), 'utf8'))

describe('over-the-air updates', () => {
  it('points at this project, not at some other one', () => {
    // The URL carries the project id, and the id is also declared for EAS. Two
    // places, one value: a copied config that kept somebody else's id would
    // publish into a project this app never reads.
    const projectId = app.extra.eas.projectId

    expect(projectId).toBeTruthy()
    expect(app.updates.url).toBe(`https://u.expo.dev/${projectId}`)
  })

  it('keys updates on the native fingerprint, never on the app version', () => {
    /*
     * The whole safety property, in one word.
     *
     * `fingerprint` hashes the native project, so a JavaScript change keeps the
     * same runtime version and the update applies, while adding a Kotlin module
     * or a native dependency changes it and the update is **refused** until a
     * build catches up. `appVersion` would happily serve a bundle calling
     * `MioForegroundTask.isRunning` to a binary that has never heard of it —
     * a crash on launch, delivered over the air, to a phone that was working.
     */
    expect(app.runtimeVersion).toEqual({ policy: 'fingerprint' })
  })

  it('gives every build profile a channel to listen on', () => {
    // A profile without one is a build that can never receive an update, which
    // looks exactly like an update that was never published.
    const profiles = Object.entries(eas.build) as [string, { channel?: string }][]

    expect(profiles.length).toBeGreaterThan(0)
    expect(profiles.filter(([, profile]) => !profile.channel).map(([name]) => name)).toEqual([])
  })

  it('exports Android and nothing else', () => {
    /*
     * The first real `eas update` failed on this, before it published anything.
     *
     * An update export builds **every platform the config allows**, and this
     * config allowed web — so Metro tried to bundle `expo-router` for web, could
     * not resolve `react-native-web`, and the whole publish died. There is no
     * Expo web client to bundle: this project's web client is the Vite app in
     * `frontend/`, which shares `shared/` and nothing else.
     *
     * Declaring the platform is better than remembering `--platform android` on
     * every command, because the command that gets forgotten is the one typed in
     * a hurry to ship a fix.
     */
    expect(app.platforms).toEqual(['android'])
  })

  it('never blocks a launch waiting for one', () => {
    // The app is a music player: it opens to what it already has and takes the
    // new bundle on the next launch. A non-zero timeout trades a fast start for
    // a spinner, on a screen the user came to press play on.
    expect(app.updates.fallbackToCacheTimeout).toBe(0)
  })
})
