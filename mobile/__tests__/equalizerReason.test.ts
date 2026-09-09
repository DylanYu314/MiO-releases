/**
 * The equaliser's refusal codes (#303, third attempt).
 *
 * The Kotlin cannot run here — no jest, no `DynamicsProcessing`, no phone. What
 * *can* run is the boundary: the mapping from whatever the native side answers
 * onto a reason this app can act on, and the rule that decides whether a
 * refusal is worth retrying.
 *
 * That boundary is worth pinning precisely because the native half is
 * unreachable. The bug survived two fixes by collapsing five different failures
 * into one `false`, and the compatibility branch below — an older binary whose
 * `setGains` still returns a boolean — is the exact binary somebody debugging
 * this is holding.
 */
import { requireOptionalNativeModule } from 'expo'

import {
  applyEqualizer,
  isTransientEqualizerReason,
  type EqualizerReason,
} from '../modules/mio-equalizer'
import { useEqualizerReach } from '../src/player/equalizerReach'

jest.mock('expo', () => ({
  ...jest.requireActual('expo'),
  requireOptionalNativeModule: jest.fn(),
}))

const mockedRequire = requireOptionalNativeModule as jest.MockedFunction<
  typeof requireOptionalNativeModule
>

/** Stands in for a deck. Nothing here reads it — it goes straight to Kotlin. */
const deck = {} as Parameters<typeof applyEqualizer>[0]

const withNativeAnswer = (answer: unknown) => {
  const setGains = jest.fn().mockReturnValue(answer)
  mockedRequire.mockReturnValue({ setGains } as never)
  return setGains
}

beforeEach(() => {
  mockedRequire.mockReset()
  useEqualizerReach.setState({ reaching: null, reason: null })
})

describe('applyEqualizer', () => {
  it('reports the native reason unchanged, so the panel names the real fault', () => {
    withNativeAnswer('no_session_yet')

    expect(applyEqualizer(deck, [0, 0])).toBe('no_session_yet')
  })

  it('answers ok only for ok', () => {
    withNativeAnswer('ok')

    expect(applyEqualizer(deck, [0, 0])).toBe('ok')
  })

  it('says no_module when the binary predates the equaliser', () => {
    // `requireOptionalNativeModule` answers null in a build without the Kotlin.
    mockedRequire.mockReturnValue(null as never)

    expect(applyEqualizer(deck, [0, 0])).toBe('no_module')
  })

  it('passes the gains through as a plain array', () => {
    const setGains = withNativeAnswer('ok')

    applyEqualizer(deck, [1, -2, 3])

    expect(setGains).toHaveBeenCalledWith(deck, [1, -2, 3])
  })

  describe('against a binary built before the codes existed', () => {
    it('reads a bare true as ok', () => {
      withNativeAnswer(true)

      expect(applyEqualizer(deck, [0, 0])).toBe('ok')
    })

    it('reads a bare false as a refusal rather than a success', () => {
      withNativeAnswer(false)

      // The specific code is a guess — an old binary cannot say which failure it
      // hit. What must not happen is `false` reading as ok.
      expect(applyEqualizer(deck, [0, 0])).not.toBe('ok')
    })
  })
})

describe('isTransientEqualizerReason', () => {
  it('is true only for a renderer that has no session yet', () => {
    expect(isTransientEqualizerReason('no_session_yet')).toBe(true)
  })

  it.each<EqualizerReason>([
    'os_too_old',
    'no_player',
    'no_session_method',
    'session_blocked',
    'effect_unavailable',
    'no_module',
  ])('is false for %s, which asking again cannot fix', (reason) => {
    expect(isTransientEqualizerReason(reason)).toBe(false)
  })

  /**
   * The qualified form (#303, fifth attempt).
   *
   * `session_blocked` now carries the exception's class, because the bare word
   * stood for three unrelated throws and three device passes answered it. The
   * retry decision must not change just because the reason got more specific —
   * that would be the fix quietly undoing itself.
   */
  it.each<EqualizerReason>([
    'session_blocked:IllegalAccessException',
    'session_blocked:InvocationTargetException',
    'session_blocked:NullPointerException',
  ])('is false for %s, exactly as the bare code is', (reason) => {
    expect(isTransientEqualizerReason(reason)).toBe(false)
  })
})

describe('the reach store', () => {
  it('derives reaching from the reason, so the two cannot disagree', () => {
    useEqualizerReach.getState().setReaching('ok')

    expect(useEqualizerReach.getState()).toMatchObject({ reaching: true, reason: 'ok' })
  })

  it('treats any non-ok reason as refused and keeps the reason', () => {
    useEqualizerReach.getState().setReaching('session_blocked')

    expect(useEqualizerReach.getState()).toMatchObject({
      reaching: false,
      reason: 'session_blocked',
    })
  })

  it('clears the reason when there is nothing playing, not just the flag', () => {
    useEqualizerReach.getState().setReaching('session_blocked')
    useEqualizerReach.getState().setReaching(null)

    // A stale reason under a cleared warning would be worse than no reason.
    expect(useEqualizerReach.getState()).toMatchObject({ reaching: null, reason: null })
  })

  it('changes state when only the reason differs', () => {
    // Both are refusals, so the bail-out guard must compare the reason too —
    // otherwise the panel keeps showing the first fault after a second one
    // replaces it.
    useEqualizerReach.getState().setReaching('no_session_yet')
    useEqualizerReach.getState().setReaching('effect_unavailable')

    expect(useEqualizerReach.getState().reason).toBe('effect_unavailable')
  })
})
