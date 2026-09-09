import { expect, type Page, test } from '@playwright/test'

/**
 * Heart a song and wait for the server to have agreed.
 *
 * The heart flips optimistically — `useToggleFavourite` sets the cached id set
 * in `onMutate`, before the request goes out — so asserting on the button and
 * then navigating races the POST. When the POST loses, the Favourites page
 * renders without the song and the test fails somewhere that looks unrelated.
 *
 * Worse, it fails *other files*: the suite shares one database and runs
 * `workers: 1`, so a favourites test that dies early leaves a different number
 * of songs hearted, and `playlists.spec.ts` then sees a second playlist with the
 * same track count. That is a real red run on `main`, not a hypothetical.
 */
const heart = async (page: Page, title: string) => {
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/playlists/favourites/items') &&
        response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: `Add ${title} to favourites` }).click(),
  ])
}

test.describe('favourites', () => {
  test('hearting a song from the library puts it in Favourites', async ({ page }) => {
    await page.goto('/')

    await heart(page, 'Beast of Burden')
    // The heart flips immediately, before the server round trip.
    await expect(
      page.getByRole('button', { name: 'Remove Beast of Burden from favourites' }),
    ).toHaveAttribute('aria-pressed', 'true')

    await page.getByRole('link', { name: 'Favourites' }).click()
    await expect(page.getByText('Beast of Burden')).toBeVisible()
  })

  test('un-hearting removes it again, leaving the song in the library', async ({ page }) => {
    await page.goto('/')
    await heart(page, 'Do It Again')

    await page.getByRole('link', { name: 'Favourites' }).click()
    await expect(page.getByText('Do It Again')).toBeVisible()

    await page.getByRole('button', { name: 'Remove Do It Again from favourites' }).click()
    // The suite shares one database, so other specs may have hearted things
    // too — assert this song is gone, not that the list is empty.
    await expect(page.getByRole('main').getByText('Do It Again')).toBeHidden()

    // The song itself is untouched — un-hearting is not deleting.
    await page.getByRole('link', { name: 'Library' }).click()
    await expect(page.getByText('Do It Again')).toBeVisible()
  })

  test('the favourites playlist cannot be deleted from the playlists page', async ({ page }) => {
    // Heart something so the playlist exists at all.
    await page.goto('/')
    await heart(page, 'Sunny')

    await page.getByRole('link', { name: 'Playlists' }).click()
    // Scoped to the list: "Favourites" is also the nav link's text.
    await expect(page.getByRole('main').getByText('Favourites')).toBeVisible()
    // Every other playlist row offers a delete button; this one must not.
    await expect(page.getByRole('button', { name: 'Delete Favourites' })).toBeHidden()
  })
})
