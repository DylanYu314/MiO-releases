import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { EqualizerPanel } from '../src/components/EqualizerPanel'
import { applyMono, isMonoSupported } from '../modules/mio-equalizer'
import { loadAudioSettings, useAudioSettings } from '../src/player/audioSettings'
import '../src/i18n'

/**
 * Mono, on the JavaScript side (#482).
 *
 * The mixing itself is Kotlin in ExoPlayer's audio sink and cannot be run here.
 * What can be — and what would otherwise ship broken without anyone noticing —
 * is **who is offered the switch**: the processor is injected by a config
 * plugin at prebuild, so a binary can hold this module without holding it, and
 * a switch that moves and changes nothing is precisely the class of lie
 * iteration v0.5.0 was named after.
 *
 * `plugins/withMonoAudioProcessor` and the Kotlin's own invariants are
 * `monoAudioProcessor.test.ts`.
 */

const mockNative: {
  isSupported: boolean
  hasMono?: boolean
  setMono?: jest.Mock
  setGains: jest.Mock
  bandCount: number
  bandFrequencies: number[]
  maxGainDb: number
} = {
  isSupported: true,
  hasMono: true,
  setMono: jest.fn(() => 'ok'),
  setGains: jest.fn(() => 'ok'),
  bandCount: 10,
  bandFrequencies: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  maxGainDb: 12,
}

/**
 * The store's default, captured **before any test can write to it**.
 *
 * The store is module state and `beforeEach` resets `mono` — so an assertion
 * about "the default" made inside a test is an assertion about the line that
 * reset it, and would pass just as happily against a default of `true`. It did:
 * the mutation survived until this line existed.
 */
const DEFAULT_MONO = useAudioSettings.getState().mono

// `mock`-prefixed so the hoisted factory may reference it — jest only exempts
// names starting with `mock`.
let mockModulePresent = true
jest.mock('expo', () => ({
  requireOptionalNativeModule: () => (mockModulePresent ? mockNative : null),
}))

beforeEach(async () => {
  jest.clearAllMocks()
  mockModulePresent = true
  mockNative.isSupported = true
  mockNative.hasMono = true
  mockNative.setMono = jest.fn(() => 'ok')
  await AsyncStorage.clear()
  useAudioSettings.setState({ mono: false })
})

describe('who gets offered mono', () => {
  it('is offered when the module and the processor are both there', () => {
    expect(isMonoSupported()).toBe(true)
  })

  it('is not offered in a binary built before the config plugin ran', () => {
    // The trap this exists for: the module has been in the app since #202, and
    // `hasMono` is the only thing that knows whether the *processor* reached
    // the APK. #478 shipped exactly this shape of silence once already.
    mockNative.hasMono = false

    expect(isMonoSupported()).toBe(false)
  })

  it('is not offered in a binary built before mono existed at all', () => {
    // An older module answers neither the constant nor the function.
    mockNative.hasMono = undefined
    mockNative.setMono = undefined

    expect(isMonoSupported()).toBe(false)
  })

  it('is not offered without the native module', () => {
    mockModulePresent = false

    expect(isMonoSupported()).toBe(false)
  })

  it('does not ask whether DynamicsProcessing is supported', () => {
    /*
     * Deliberately independent of the equaliser's own gate. `isSupported` is
     * API 28 for `DynamicsProcessing`, and channel mixing has nothing to do
     * with `DynamicsProcessing` — reusing that gate would hide mono on Android
     * 7 and 8 for a reason that does not apply to it.
     */
    mockNative.isSupported = false

    expect(isMonoSupported()).toBe(true)
  })
})

describe('applyMono', () => {
  it('passes the setting straight to the sink, with no player', () => {
    // No player argument, and that is the design: the flag is process-wide, so
    // crossfade's two decks cannot be mixed differently and a new deck needs no
    // re-application.
    expect(applyMono(true)).toBe('ok')
    expect(mockNative.setMono).toHaveBeenCalledWith(true)
  })

  it('reports a missing processor by name rather than as a generic refusal', () => {
    mockNative.setMono = jest.fn(() => 'no_processor')

    expect(applyMono(true)).toBe('no_processor')
  })

  it('answers no_module when there is nothing to call', () => {
    mockModulePresent = false

    expect(applyMono(true)).toBe('no_module')
  })

  it('still understands a boolean, for a binary that predates the codes', () => {
    mockNative.setMono = jest.fn(() => false as unknown as 'ok')

    expect(applyMono(true)).toBe('refused')
  })
})

describe('the setting', () => {
  it('is off by default, because stereo is what the recording is', () => {
    expect(DEFAULT_MONO).toBe(false)
  })

  it('survives a restart', async () => {
    await act(async () => {
      await useAudioSettings.getState().setMono(true)
    })

    useAudioSettings.setState({ mono: false })
    await act(async () => {
      await loadAudioSettings()
    })

    expect(useAudioSettings.getState().mono).toBe(true)
  })

  it('leaves whatever is set alone when nothing was ever stored', async () => {
    /*
     * "Never touched it" and "turned it off" must not be stored differently —
     * only an explicit choice has to survive. Asserted by setting the *opposite*
     * of the default first: a load that wrote `false` over it would look correct
     * against a fresh store, and would be wrong.
     */
    useAudioSettings.setState({ mono: true })

    await act(async () => {
      await loadAudioSettings()
    })

    expect(useAudioSettings.getState().mono).toBe(true)
  })
})

describe('the panel', () => {
  /** Awaited, as every other panel test does it: the first render in a jest
   *  worker mounts the StyleSheet registry and i18n with it (#279). */
  const renderPanel = () =>
    render(
      <GestureHandlerRootView>
        <EqualizerPanel />
      </GestureHandlerRootView>,
    )

  it('shows the switch and turns the setting on', async () => {
    await renderPanel()

    const toggle = screen.getByLabelText('Play in mono')
    await act(async () => {
      fireEvent(toggle, 'valueChange', true)
    })

    expect(useAudioSettings.getState().mono).toBe(true)
  })

  it('says what mono is for, not just what it does', async () => {
    // Mono reads like a downgrade unless the reason is on screen. The hint is
    // the feature's whole justification: one earbud, or ears that differ.
    await renderPanel()

    expect(screen.getByText(/one earbud/i)).toBeTruthy()
  })

  it('offers nothing at all when the processor is not in the binary', async () => {
    mockNative.hasMono = false

    await renderPanel()

    expect(screen.queryByLabelText('Play in mono')).toBeNull()
  })
})
