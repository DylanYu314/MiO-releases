import { beforeEach, describe, expect, it } from 'vitest'

import { useThemeStore } from './store'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  document.documentElement.removeAttribute('style')
  useThemeStore.setState({ mode: 'system', accent: 'indigo' })
})

describe('theme store', () => {
  it('dark mode adds the .dark class and persists', () => {
    useThemeStore.getState().setMode('dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('mio-theme-mode')).toBe('dark')
  })

  it('light mode removes the .dark class', () => {
    useThemeStore.getState().setMode('dark')
    useThemeStore.getState().setMode('light')
    expect(document.documentElement).not.toHaveClass('dark')
  })

  it('system mode follows the OS (stubbed to light)', () => {
    useThemeStore.getState().setMode('dark')
    useThemeStore.getState().setMode('system')
    expect(document.documentElement).not.toHaveClass('dark')
    expect(localStorage.getItem('mio-theme-mode')).toBe('system')
  })

  it('setting an accent writes the CSS variables and persists', () => {
    useThemeStore.getState().setAccent('rose')
    expect(document.documentElement.style.getPropertyValue('--color-accent-600')).toBe('#e11d48')
    expect(localStorage.getItem('mio-theme-accent')).toBe('rose')
  })
})
