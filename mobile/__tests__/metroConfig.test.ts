/// <reference types="node" />
// Scoped to this file rather than added to `types` in tsconfig.json. Node's
// globals belong in a test that reads a config file off disk, and nowhere near
// app code — with them on project-wide, importing `fs` in a screen would
// typecheck happily and then crash on a phone.
import fs from 'fs'
import path from 'path'

/**
 * Metro's watched set is configuration that nothing else can assert.
 *
 * `shared/` lives outside the project root and is reached through a symlink, so
 * Metro ignores changes to it unless told otherwise. Nothing else in the suite
 * can notice: jest resolves `@mio/shared/*` through node, and `expo export`
 * bundles correctly from cold. The only symptom is a *running dev server* that
 * cannot see a file which demonstrably exists — which is how it reached a real
 * device instead of CI.
 *
 * **This reads the file as text rather than requiring it**, which is uglier than
 * it looks and deliberate. `expo/metro-config` ships ESM that jest-expo does not
 * transform, so importing the real config would mean widening
 * `transformIgnorePatterns` for the whole suite to assert one array. The
 * regression actually worth catching is blunt — someone deletes this config, or
 * replaces `getDefaultConfig` with a hand-rolled object — and a text check
 * catches exactly that.
 */
describe('metro config', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'metro.config.js'), 'utf8')

  it('exists and watches the shared package', () => {
    expect(source).toMatch(/watchFolders/)
    expect(source).toMatch(/['"]shared['"]/)
  })

  it('builds on the Expo defaults rather than replacing them', () => {
    // A hand-rolled config would drop the asset and TypeScript pipelines in ways
    // only a real bundle would reveal.
    expect(source).toMatch(/getDefaultConfig/)
  })

  it('points at a shared directory that is actually there', () => {
    // Guards the other direction: the config could be perfect and the path wrong.
    const shared = path.resolve(__dirname, '..', '..', 'shared')
    expect(fs.existsSync(path.join(shared, 'loudness.ts'))).toBe(true)
    expect(fs.existsSync(path.join(shared, 'i18n', 'en.json'))).toBe(true)
  })
})
