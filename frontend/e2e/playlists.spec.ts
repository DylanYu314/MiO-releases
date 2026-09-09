import { expect, test } from '@playwright/test'

/** Playlists exercise every verb: POST, GET, POST item, DELETE item, DELETE. */
test.describe('playlists', () => {
  test('shows the seeded playlist and its track count', async ({ page }) => {
    await page.goto('/playlists')

    // Scoped to the row, not the page. A bare `getByText('1 song')` asserts
    // something this spec does not control: the suite shares one database and
    // runs `workers: 1`, so `favourites.spec.ts` has already run and left the
    // Favourites playlist holding however many songs it happened to finish
    // with. When that number was also one, this matched two rows and failed on
    // strict mode — a red `main` whose cause was in another file entirely.
    await expect(page.getByRole('link', { name: 'Seeded Playlist 1 song' })).toBeVisible()
  })

  test('creates a playlist, fills it from the library, then empties it', async ({ page }) => {
    const name = `E2E Playlist ${Date.now()}`

    await page.goto('/playlists')
    await page.getByLabel('New playlist name').fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(name)).toBeVisible()

    // Add a song to it from the library's per-row menu.
    await page.goto('/')
    await page.getByRole('button', { name: 'Add Green River to a playlist' }).click()
    // Wait for the server to have taken the item before navigating away.
    // `page.goto` immediately after the click races the POST, and losing that
    // race renders the playlist empty — the same optimistic-update trap the
    // `heart` helper in `favourites.spec.ts` exists for.
    await Promise.all([
      page.waitForResponse(
        (response) =>
          /\/playlists\/\d+\/items$/.test(new URL(response.url()).pathname) &&
          response.request().method() === 'POST',
      ),
      page.getByRole('menuitem', { name }).click(),
    ])

    await page.goto('/playlists')
    await page.getByText(name).click()
    // Exact: playlist rows now carry the same "artist — album" subtitle as the
    // library, and this track's album is also called Green River.
    await expect(page.getByText('Green River', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Remove Green River from playlist' }).click()
    await expect(page.getByText(/this playlist is empty/i)).toBeVisible()
  })

  test('deletes a playlist after confirming', async ({ page }) => {
    const name = `Doomed Playlist ${Date.now()}`

    await page.goto('/playlists')
    await page.getByLabel('New playlist name').fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByText(name)).toBeVisible()

    await page.getByRole('button', { name: `Delete ${name}` }).click()
    // Confirm in the modal dialog (replaced the old native window.confirm).
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()

    await expect(page.getByText(name)).toBeHidden()
  })

  test('renames a playlist', async ({ page }) => {
    const name = `Renameable ${Date.now()}`

    await page.goto('/playlists')
    await page.getByLabel('New playlist name').fill(name)
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByText(name).click()

    await page.getByRole('button', { name: 'Rename' }).click()
    await page.getByLabel('Playlist name').fill(`${name} (renamed)`)
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByRole('heading', { name: `${name} (renamed)` })).toBeVisible()
  })
})
