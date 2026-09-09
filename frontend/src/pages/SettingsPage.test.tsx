import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderWithProviders } from '../test/renderWithProviders'
import { useThemeStore } from '../theme/store'
import { SettingsPage } from './SettingsPage'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  useThemeStore.setState({ mode: 'system', accent: 'indigo' })
})

describe('SettingsPage', () => {
  it('switches to dark mode when the Dark option is chosen', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)

    await user.click(screen.getByRole('radio', { name: 'Dark' }))

    expect(document.documentElement).toHaveClass('dark')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
  })

  it('applies an accent when a swatch is chosen', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)

    await user.click(screen.getByRole('button', { name: 'Emerald' }))

    expect(useThemeStore.getState().accent).toBe('emerald')
    expect(document.documentElement.style.getPropertyValue('--color-accent-600')).toBe('#059669')
  })

  it('hosts the language switcher', () => {
    renderWithProviders(<SettingsPage />)
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
  })

  it('saves an access key to local storage', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SettingsPage />)

    await user.type(screen.getByLabelText('Access key'), 'my-secret-key')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(localStorage.getItem('mio-access-key')).toBe('my-secret-key')
  })
})
