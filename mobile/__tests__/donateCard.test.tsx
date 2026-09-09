import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Linking } from 'react-native'

import { DonateCard, KOFI_URL } from '../src/components/DonateCard'
import { showToast } from '../src/components/Toast'
import i18n from '../src/i18n'

jest.mock('../src/components/Toast', () => ({ showToast: jest.fn() }))

describe('DonateCard', () => {
  beforeEach(() => jest.restoreAllMocks())

  it('opens the Ko-fi page and nothing else', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    await render(<DonateCard />)

    fireEvent.press(screen.getByRole('link'))

    await waitFor(() => expect(open).toHaveBeenCalledWith(KOFI_URL))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('says so when there is no browser to open, instead of doing nothing', async () => {
    // ⚠️ An Android with no browser throws here. The first version of this
    // component used a bare `void`, which would have made the button silently
    // dead — the failure mode a donate button can least afford.
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no activity'))
    await render(<DonateCard />)

    fireEvent.press(screen.getByRole('link'))

    await waitFor(() => expect(showToast).toHaveBeenCalled())
  })

  it('tells the user the donation unlocks nothing', async () => {
    // ⛔ the project's ground rules: a donation grants **nothing**. The
    // card has to say so where the user is deciding, not only in a policy file.
    await render(<DonateCard />)
    expect(screen.getByText(/unlocks nothing/i)).toBeTruthy()
  })

  it('uses the short body on the player screen', async () => {
    await render(<DonateCard compact />)
    expect(screen.getByText(i18n.t('donate.bodyShort'))).toBeTruthy()
  })

  it('uses the full body in Settings, and it really is longer', async () => {
    // ⚠️ Two renders in one test would need a hand-written `unmount()`, and a
    // stray one of those has already broken the *next* test in this suite
    // once. RNTL cleans up between tests; the length comparison is a fact
    // about the catalogue, so it is asserted against the catalogue.
    await render(<DonateCard />)
    expect(screen.getByText(i18n.t('donate.body'))).toBeTruthy()
    expect(i18n.t('donate.body').length).toBeGreaterThan(i18n.t('donate.bodyShort').length)
  })
})

describe('the donation route grants nothing — the invariant', () => {
  /*
   * ⛔ This is the rule the ground rules are built on: a
   * donation that gives something back is a sale by another name. A guard,
   * not a comment, because the last three "documented invariants nothing
   * enforced" in this repo all turned out to be false (#555, #561, #695).
   */
  const source = readFileSync(join(__dirname, '..', 'src/components/DonateCard.tsx'), 'utf8')

  it('reads the source — the control', () => {
    expect(source).toContain('KOFI_URL')
    expect(source.length).toBeGreaterThan(500)
  })

  it('has no state, so it cannot know or reward who gave', () => {
    // Any of these would mean the card remembers something about the user, and
    // remembering is the first half of granting.
    expect(source).not.toMatch(/useState|useStore|AsyncStorage|SecureStore/)
  })

  it('reaches no MiO endpoint — Ko-fi is the entire payment system', () => {
    const urls = source.match(/https?:\/\/[^\s'"`]+/g) ?? []
    expect(urls.length).toBeGreaterThan(0) // control: there is a URL to judge
    for (const url of urls) expect(url).toContain('ko-fi.com')
  })
})
