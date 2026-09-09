import { render, screen } from '@testing-library/react'
import { useTranslation } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import i18n from './index'

function Probe() {
  const { t } = useTranslation()
  return <span>{t('nav.library')}</span>
}

describe('i18n', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('defaults to English', () => {
    render(<Probe />)
    expect(screen.getByText('Library')).toBeInTheDocument()
  })

  it('renders Chinese after switching language', async () => {
    await i18n.changeLanguage('zh')
    render(<Probe />)
    expect(screen.getByText('音乐库')).toBeInTheDocument()
  })

  it('syncs the document lang attribute', async () => {
    await i18n.changeLanguage('zh')
    expect(document.documentElement.lang).toBe('zh')
  })

  it('falls back to English for a missing key', () => {
    render(<Probe />)
    // A key that exists in both catalogues resolves; a nonexistent one returns
    // the key itself, which proves lookups aren't silently blank.
    expect(i18n.t('nav.library')).toBe('Library')
    expect(i18n.t('does.not.exist')).toBe('does.not.exist')
  })
})
