import { expect, test } from '@playwright/test'

// Opt out of the pre-completed onboarding state so the first-run tour shows.
test.use({ storageState: { cookies: [], origins: [] } })

test.describe('first-run onboarding', () => {
  test('walks through the tour and does not return once finished', async ({ page }) => {
    await page.goto('/')

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Welcome to MiO')).toBeVisible()

    await dialog.getByRole('button', { name: 'Next' }).click()
    await expect(dialog.getByText('Your library & player')).toBeVisible()

    await dialog.getByRole('button', { name: 'Skip' }).click()
    await expect(page.getByRole('dialog')).toBeHidden()

    // The choice sticks across a reload.
    await page.reload()
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})
