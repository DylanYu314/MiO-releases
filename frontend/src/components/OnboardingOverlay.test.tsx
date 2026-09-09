import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { useOnboardingStore } from '../onboarding/store'
import { renderWithProviders } from '../test/renderWithProviders'
import { OnboardingOverlay } from './OnboardingOverlay'

beforeEach(() => {
  localStorage.clear()
  useOnboardingStore.setState({ completed: false })
})

describe('OnboardingOverlay', () => {
  it('opens on the welcome step with Back disabled', () => {
    renderWithProviders(<OnboardingOverlay />)

    expect(screen.getByText('Welcome to MiO')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('advances to the next step with Next', async () => {
    renderWithProviders(<OnboardingOverlay />)

    await userEvent.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('Your library & player')).toBeInTheDocument()
  })

  it('completes the tour from the final step', async () => {
    renderWithProviders(<OnboardingOverlay />)

    // welcome -> listen -> add -> personalize
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Get started' }))

    expect(useOnboardingStore.getState().completed).toBe(true)
  })

  it('completes the tour when skipped', async () => {
    renderWithProviders(<OnboardingOverlay />)

    await userEvent.click(screen.getByRole('button', { name: 'Skip' }))

    expect(useOnboardingStore.getState().completed).toBe(true)
  })
})
