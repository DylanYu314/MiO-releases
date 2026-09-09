import { expect, test } from '@playwright/test'

test.describe('navigation and degraded states', () => {
  test('moves between the main sections', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('link', { name: 'Playlists' }).click()
    await expect(page).toHaveURL(/\/playlists$/)

    await page.getByRole('link', { name: 'Add link' }).click()
    await expect(page.getByRole('heading', { name: 'Add a link' })).toBeVisible()

    await page.getByRole('link', { name: 'Search' }).click()
    await expect(page).toHaveURL(/\/search$/)
    await expect(page.getByPlaceholder(/search for a song/i)).toBeVisible()

    await page.getByRole('link', { name: 'Library' }).click()
    await expect(page.getByLabel('Search songs')).toBeVisible()
  })

  test('an unknown route shows the not-found message', async ({ page }) => {
    await page.goto('/no-such-page')

    await expect(page.getByText(/page not found/i)).toBeVisible()
  })

  test('the import page explains that Spotify is not configured', async ({ page }) => {
    // The e2e backend runs without SPOTIFY_CLIENT_ID, which is the state a
    // fresh checkout is in — it must be explained, not broken.
    await page.goto('/import')

    await expect(page.getByText(/isn't set up on this server/i)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Connect Spotify' })).toBeHidden()

    // The YouTube-playlist import needs no Spotify, so it's always available.
    await expect(page.getByRole('heading', { name: 'Import a YouTube playlist' })).toBeVisible()
  })
})
