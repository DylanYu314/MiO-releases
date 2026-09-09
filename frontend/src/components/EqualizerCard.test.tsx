import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { EQ_BANDS } from '../player/audioGraph'
import { EQ_PRESETS, useAudioSettingsStore } from '../player/audioSettings'
import { EqualizerCard } from './EqualizerCard'

beforeEach(() => {
  useAudioSettingsStore.setState({
    eqGains: EQ_PRESETS.flat,
    preset: 'flat',
    channelMode: 'stereo',
    balance: 0,
  })
})

describe('EqualizerCard', () => {
  it('shows one labelled slider per band', () => {
    render(<EqualizerCard />)

    for (const frequency of EQ_BANDS) {
      const label = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)
      expect(screen.getByLabelText(`${label} hertz band`)).toBeInTheDocument()
    }
  })

  it('says plainly when it is not changing the sound', () => {
    render(<EqualizerCard />)
    expect(screen.getByText('Not changing the sound')).toBeInTheDocument()
  })

  it('reports itself active once a preset is applied', async () => {
    const user = userEvent.setup()
    render(<EqualizerCard />)

    await user.click(screen.getByRole('radio', { name: 'Bass boost' }))

    expect(useAudioSettingsStore.getState().eqGains).toEqual(EQ_PRESETS.bass)
    expect(screen.getByText('Shaping the sound')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Bass boost' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('falls back to "custom" once a band is moved by hand', () => {
    render(<EqualizerCard />)

    // Range inputs don't respond to userEvent.click meaningfully; drive the
    // store the way the slider's onChange does.
    act(() => useAudioSettingsStore.getState().setBandGain(0, 6))

    expect(screen.getByText('Custom')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Flat' })).toHaveAttribute('aria-checked', 'false')
  })

  it('resets back to flat', async () => {
    const user = userEvent.setup()
    useAudioSettingsStore.getState().applyPreset('treble')
    render(<EqualizerCard />)

    await user.click(screen.getByRole('button', { name: 'Reset to flat' }))

    expect(useAudioSettingsStore.getState().eqGains).toEqual(EQ_PRESETS.flat)
  })

  it('switches to mono', async () => {
    const user = userEvent.setup()
    render(<EqualizerCard />)

    await user.click(screen.getByRole('radio', { name: 'Mono' }))

    expect(useAudioSettingsStore.getState().channelMode).toBe('mono')
  })

  it('names the balance position rather than showing a bare number', () => {
    render(<EqualizerCard />)
    expect(screen.getByText('Centre')).toBeInTheDocument()

    act(() => useAudioSettingsStore.getState().setBalance(-0.5))
    expect(screen.getByText('50% left')).toBeInTheDocument()

    act(() => useAudioSettingsStore.getState().setBalance(0.3))
    expect(screen.getByText('30% right')).toBeInTheDocument()
  })
})
