/* eslint-disable no-extend-native -- Removing `String.prototype.normalize` is
   the whole point of one of these cases: it is the only way to exercise a
   runtime without it, which jest never provides. It is restored in the same
   test. */

import { logInfo } from '../src/diagnostics/log'
import {
  __resetCapabilities,
  detectCapabilities,
  reportCapabilities,
} from '../src/diagnostics/capabilities'

jest.mock('../src/diagnostics/log', () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}))

const info = logInfo as jest.MockedFunction<typeof logInfo>

describe('runtime capabilities', () => {
  beforeEach(() => {
    info.mockClear()
    __resetCapabilities()
  })

  it('reports the whole set, not only what is missing', () => {
    // ⚠️ The control that matters. A line printed only on failure cannot be
    // told apart from a probe that never ran — #371's `running=false`, which
    // could never have printed anything else.
    reportCapabilities()

    const [event, summary] = info.mock.calls[0]
    expect(event).toBe('runtime.capabilities')
    for (const name of [
      'normalize',
      'intlPluralRules',
      'textDecoder',
      'webCrypto',
      'intlSegmenter',
    ]) {
      expect(summary).toContain(`${name}=`)
    }
  })

  it('reports once per launch, however many times it is called', () => {
    reportCapabilities()
    reportCapabilities()
    reportCapabilities()

    expect(info).toHaveBeenCalledTimes(1)
  })

  it('notices a capability that is missing', () => {
    const real = String.prototype.normalize
    Object.defineProperty(String.prototype, 'normalize', {
      value: undefined,
      configurable: true,
      writable: true,
    })
    try {
      expect(detectCapabilities().normalize).toBe(false)
    } finally {
      Object.defineProperty(String.prototype, 'normalize', {
        value: real,
        configurable: true,
        writable: true,
      })
    }
  })

  it('notices one that is present, so the check is not stuck on false', () => {
    expect(detectCapabilities().normalize).toBe(true)
  })

  it('does not throw on a runtime missing the globals entirely', () => {
    // A bare `TextDecoder` reference would be a ReferenceError rather than
    // `undefined` — the probe must not crash exactly where it is most needed.
    const globals = globalThis as { TextDecoder?: unknown; Intl?: unknown }
    const realDecoder = globals.TextDecoder
    const realIntl = globals.Intl
    delete globals.TextDecoder
    delete globals.Intl
    try {
      expect(() => detectCapabilities()).not.toThrow()
      expect(detectCapabilities()).toMatchObject({ textDecoder: false, intlPluralRules: false })
    } finally {
      globals.TextDecoder = realDecoder
      globals.Intl = realIntl
    }
  })
})
