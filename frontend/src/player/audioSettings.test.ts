import { beforeEach, describe, expect, it } from 'vitest'

import { EQ_BANDS, EQ_MAX_GAIN_DB, applyAudioProcessing, getAudioGraph } from './audioGraph'
import { EQ_PRESETS, selectIsNeutral, useAudioSettingsStore } from './audioSettings'

beforeEach(() => {
  useAudioSettingsStore.setState({
    eqGains: EQ_PRESETS.flat,
    preset: 'flat',
    channelMode: 'stereo',
    balance: 0,
  })
})

describe('audio settings store', () => {
  it('starts flat, centred and in stereo', () => {
    const state = useAudioSettingsStore.getState()
    expect(state.eqGains).toEqual(EQ_PRESETS.flat)
    expect(state.channelMode).toBe('stereo')
    expect(state.balance).toBe(0)
    expect(selectIsNeutral(state)).toBe(true)
  })

  it('has a gain for every band in every preset', () => {
    // A preset one entry short would silently leave the top band unset.
    for (const [name, curve] of Object.entries(EQ_PRESETS)) {
      expect(curve, name).toHaveLength(EQ_BANDS.length)
      for (const gain of curve) expect(Math.abs(gain)).toBeLessThanOrEqual(EQ_MAX_GAIN_DB)
    }
  })

  it('applies a preset and remembers which one', () => {
    useAudioSettingsStore.getState().applyPreset('bass')

    expect(useAudioSettingsStore.getState().eqGains).toEqual(EQ_PRESETS.bass)
    expect(useAudioSettingsStore.getState().preset).toBe('bass')
    expect(selectIsNeutral(useAudioSettingsStore.getState())).toBe(false)
  })

  it('does not hand out the preset array itself', () => {
    // A preset held by reference would be mutated by the next slider drag,
    // permanently corrupting it for the rest of the session.
    useAudioSettingsStore.getState().applyPreset('vocal')
    useAudioSettingsStore.getState().setBandGain(0, 5)

    expect(EQ_PRESETS.vocal[0]).toBe(-3)
  })

  it('drops the preset label once a band is moved by hand', () => {
    useAudioSettingsStore.getState().applyPreset('treble')
    useAudioSettingsStore.getState().setBandGain(3, 6)

    const state = useAudioSettingsStore.getState()
    expect(state.preset).toBeNull()
    expect(state.eqGains[3]).toBe(6)
  })

  it('clamps band gains to the usable range', () => {
    useAudioSettingsStore.getState().setBandGain(0, 999)
    expect(useAudioSettingsStore.getState().eqGains[0]).toBe(EQ_MAX_GAIN_DB)

    useAudioSettingsStore.getState().setBandGain(0, -999)
    expect(useAudioSettingsStore.getState().eqGains[0]).toBe(-EQ_MAX_GAIN_DB)
  })

  it('ignores a band that does not exist', () => {
    const before = useAudioSettingsStore.getState().eqGains
    useAudioSettingsStore.getState().setBandGain(99, 6)
    expect(useAudioSettingsStore.getState().eqGains).toEqual(before)
  })

  it('resets back to flat', () => {
    useAudioSettingsStore.getState().applyPreset('bass')
    useAudioSettingsStore.getState().resetEq()

    expect(useAudioSettingsStore.getState().eqGains).toEqual(EQ_PRESETS.flat)
    expect(useAudioSettingsStore.getState().preset).toBe('flat')
  })

  it('clamps balance to the stereo field', () => {
    useAudioSettingsStore.getState().setBalance(-4)
    expect(useAudioSettingsStore.getState().balance).toBe(-1)

    useAudioSettingsStore.getState().setBalance(4)
    expect(useAudioSettingsStore.getState().balance).toBe(1)
  })

  it('counts mono and off-centre balance as not neutral', () => {
    useAudioSettingsStore.getState().setChannelMode('mono')
    expect(selectIsNeutral(useAudioSettingsStore.getState())).toBe(false)

    useAudioSettingsStore.getState().setChannelMode('stereo')
    useAudioSettingsStore.getState().setBalance(0.5)
    expect(selectIsNeutral(useAudioSettingsStore.getState())).toBe(false)
  })
})

describe('applying settings to the graph', () => {
  function graph() {
    return getAudioGraph(document.createElement('audio'))!
  }

  it('builds one filter per band, flat and correctly typed', () => {
    const { eq } = graph()
    expect(eq).toHaveLength(EQ_BANDS.length)

    // Shelves at the ends so a boost at 31 Hz lifts everything below it too,
    // rather than putting a bump around 31 and leaving 20 Hz untouched.
    expect(eq[0].type).toBe('lowshelf')
    expect(eq.at(-1)!.type).toBe('highshelf')
    for (const filter of eq.slice(1, -1)) expect(filter.type).toBe('peaking')

    eq.forEach((filter, index) => {
      expect(filter.frequency.value).toBe(EQ_BANDS[index])
      expect(filter.gain.value).toBe(0)
    })
  })

  it('starts stereo, centred — the chain is a no-op until asked', () => {
    const built = graph()
    expect(built.channelMix.channelCount).toBe(2)
    expect(built.panner.pan.value).toBe(0)
  })

  it('pushes band gains onto the filters', () => {
    const built = graph()
    applyAudioProcessing(built, {
      eqGains: EQ_PRESETS.bass,
      channelMode: 'stereo',
      balance: 0,
    })

    built.eq.forEach((filter, index) => {
      expect(filter.gain.value).toBe(EQ_PRESETS.bass[index])
    })
  })

  it('downmixes to mono by asking for a single channel', () => {
    // channelCount 1 with explicit/speakers is the spec's own (L+R)/2 downmix,
    // which is one node instead of a splitter/merger lattice.
    const built = graph()
    applyAudioProcessing(built, { eqGains: EQ_PRESETS.flat, channelMode: 'mono', balance: 0 })
    expect(built.channelMix.channelCount).toBe(1)

    applyAudioProcessing(built, { eqGains: EQ_PRESETS.flat, channelMode: 'stereo', balance: 0 })
    expect(built.channelMix.channelCount).toBe(2)
  })

  it('sets balance on the panner, clamped', () => {
    const built = graph()
    applyAudioProcessing(built, { eqGains: EQ_PRESETS.flat, channelMode: 'stereo', balance: -0.4 })
    expect(built.panner.pan.value).toBeCloseTo(-0.4)

    applyAudioProcessing(built, { eqGains: EQ_PRESETS.flat, channelMode: 'stereo', balance: 12 })
    expect(built.panner.pan.value).toBe(1)
  })

  it('clamps out-of-range band gains rather than trusting the caller', () => {
    const built = graph()
    applyAudioProcessing(built, {
      eqGains: [99, -99, 0, 0, 0, 0, 0, 0, 0, 0],
      channelMode: 'stereo',
      balance: 0,
    })
    expect(built.eq[0].gain.value).toBe(EQ_MAX_GAIN_DB)
    expect(built.eq[1].gain.value).toBe(-EQ_MAX_GAIN_DB)
  })

  it('treats a short gains array as flat for the missing bands', () => {
    const built = graph()
    applyAudioProcessing(built, { eqGains: [6], channelMode: 'stereo', balance: 0 })
    expect(built.eq[0].gain.value).toBe(6)
    for (const filter of built.eq.slice(1)) expect(filter.gain.value).toBe(0)
  })
})
