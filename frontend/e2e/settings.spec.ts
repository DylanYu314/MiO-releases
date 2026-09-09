import { expect, test } from '@playwright/test'

test.describe('settings', () => {
  test('dark theme is applied and survives a reload', async ({ page }) => {
    await page.goto('/settings')

    await page.getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    // The pre-paint script must re-apply it before first paint, with no flash.
    await page.reload()
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('choosing an accent updates the token variable', async ({ page }) => {
    await page.goto('/settings')

    await page.getByRole('button', { name: 'Rose' }).click()

    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-accent-600').trim(),
    )
    expect(accent).toBe('#e11d48')
  })

  test('an access key entered in settings is stored on the device', async ({ page }) => {
    await page.goto('/settings')

    await page.getByLabel('Access key').fill('unlock-me')
    await page.getByRole('button', { name: 'Save' }).click()

    const stored = await page.evaluate(() => localStorage.getItem('mio-access-key'))
    expect(stored).toBe('unlock-me')
  })
})
