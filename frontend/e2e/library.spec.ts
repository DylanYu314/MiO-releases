import { expect, test } from '@playwright/test'

/**
 * The library round trip: browser → Vite proxy → FastAPI → SQLite → back.
 * Every unit test on either side fakes the other, so this is the only place
 * the query parameters and the response shape are checked against each other.
 */
test.describe('library', () => {
  test('lists the seeded songs with their artists', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByText('Beast of Burden')).toBeVisible()
    await expect(page.getByText('The Rolling Stones').first()).toBeVisible()
    await expect(page.getByText('30 songs')).toBeVisible()
  })

  test('search narrows the list to matching songs', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Beast of Burden')).toBeVisible()

    await page.getByLabel('Search songs').fill('steely')

    await expect(page.getByText('Do It Again')).toBeVisible()
    await expect(page.getByText('Beast of Burden')).toBeHidden()
    await expect(page.getByText('1 song', { exact: true })).toBeVisible()
  })

  test('search that matches nothing says so', async ({ page }) => {
    await page.goto('/')

    await page.getByLabel('Search songs').fill('zzzznotasong')

    await expect(page.getByText(/no songs match/i)).toBeVisible()
  })

  test('sorting by title reorders the list', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Beast of Burden')).toBeVisible()

    await page.getByLabel('Sort songs').selectOption('title:asc')

    // Alphabetically first of the seeded titles.
    await expect(page.getByRole('listitem').first()).toContainText('Beast of Burden')
  })

  test('pagination moves through the library', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('Page 1 of 2')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()

    await page.getByRole('button', { name: 'Next', exact: true }).click()

    await expect(page.getByText('Page 2 of 2')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled()
  })

  test('selecting a song loads it into the player bar', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Play Do It Again', exact: true }).click()

    // The bar lives outside the routes, so it persists across navigation.
    const player = page.locator('footer, [class*="fixed"]').filter({ hasText: 'Do It Again' })
    await expect(player.first()).toBeVisible()
    await page.getByRole('link', { name: 'Playlists' }).click()
    await expect(player.first()).toBeVisible()
  })
})
