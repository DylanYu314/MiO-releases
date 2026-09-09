/**
 * A stub for `youtubei.js/react-native` under jest.
 *
 * The package is ESM and 1.7 MB, and jest does not transform `node_modules`.
 * That is fine for the tests that care about extraction — `extract.test.ts`
 * mocks it explicitly — but it broke three separate *screen* suites that had
 * merely rendered something which, several imports later, reached it.
 *
 * Mapping it here means no test trips over it for reaching a screen, while a
 * test that genuinely exercises extraction still supplies its own mock. The
 * alternative, transforming the package, would slow every run to serve one
 * suite that does not need the real thing either.
 */
module.exports = {
  Innertube: { create: async () => ({}) },
  Platform: { load: () => {}, shim: {} },
  Constants: { CLIENTS: {} },
}
