/**
 * The runtime half of #609 — the parts jest can check that the golden fixture
 * cannot.
 *
 * ⚠️ **`String.prototype.normalize` is the open question.** Node has it, so
 * every fixture assertion passes here regardless of whether Hermes does. That
 * is the same shape as `TextDecoder` (jest has it, Hermes does not, so
 * `audioTags.ts` is hand-rolled) and `Intl.PluralRules` (#557, where a render
 * test would have passed against the broken app). So rather than assume,
 * `matching.ts` degrades loudly — and this suite proves the degraded path both
 * *works* and *announces itself*.
 */

/* eslint-disable no-extend-native -- Replacing `String.prototype.normalize` is
   the whole point of this suite: it is the only way to exercise the Hermes-shaped
   runtime that jest itself never provides. Both edits are restored in afterEach. */

import { logWarn } from '../src/diagnostics/log'
import { normalize, resetNormalizeWarning } from '../src/library/matching'

jest.mock('../src/diagnostics/log', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}))

const warn = logWarn as jest.MockedFunction<typeof logWarn>

describe('normalize() without String.prototype.normalize', () => {
  const real = String.prototype.normalize

  beforeEach(() => {
    warn.mockClear()
    resetNormalizeWarning()
  })

  afterEach(() => {
    // Assigning back rather than deleting: `delete` on a prototype method that
    // was never an own property of the instance would leave the built-in in
    // place and silently make every test here a no-op.
    Object.defineProperty(String.prototype, 'normalize', {
      value: real,
      configurable: true,
      writable: true,
    })
  })

  function removeNormalize(): void {
    Object.defineProperty(String.prototype, 'normalize', {
      value: undefined,
      configurable: true,
      writable: true,
    })
  }

  it('is present in this runtime, so the control is meaningful', () => {
    // Without this, a change that broke the removal would make every
    // assertion below vacuously true.
    expect(typeof String.prototype.normalize).toBe('function')
    expect(normalize('Café')).toBe('cafe')
  })

  it('still folds case, punctuation and noise brackets', () => {
    removeNormalize()
    expect(normalize('Blinding Lights (Official Video)')).toBe('blinding lights')
    expect(normalize('Straße')).toBe('strasse')
    expect(normalize('稻香')).toBe('稻香')
  })

  it('says so in the diagnostics log, once', () => {
    removeNormalize()
    normalize('Café')
    normalize('Déjà')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('matching.noNormalize', expect.stringContaining('normalize'))
  })

  it('does not warn when the runtime has it', () => {
    normalize('Café')
    expect(warn).not.toHaveBeenCalled()
  })
})
