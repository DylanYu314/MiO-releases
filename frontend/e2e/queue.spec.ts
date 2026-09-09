import { expect, test, type Page } from '@playwright/test'

/** The panel shows two tiers, and the same song can legitimately sit in both —
 *  so every assertion has to name which section it means. */
function queueSection(page: Page, heading: RegExp) {
  return page
    .getByRole('dialog', { name: 'Play queue' })
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading }) })
}

async function openQueue(page: Page) {
  await page.getByRole('button', { name: 'Open the play queue' }).click()
}

test.describe('play queue', () => {
  test('hand-queued tracks survive playing something else', async ({ page }) => {
    await page.goto('/')

    // Start the library playing, then queue a different track by hand.
    await page.getByRole('button', { name: 'Play Beast of Burden', exact: true }).click()
    await page.getByRole('button', { name: 'Add Do It Again to queue' }).click()

    await openQueue(page)
    await expect(queueSection(page, /next in queue/i).getByText('Do It Again')).toBeVisible()
    await page.getByRole('button', { name: 'Close the play queue' }).click()

    // Play a whole playlist — the old flat queue threw hand-queued tracks away
    // at exactly this point.
    await page.getByRole('link', { name: 'Playlists' }).click()
    await page.getByText('Seeded Playlist').click()
    await page.getByRole('button', { name: 'Play all' }).click()

    await openQueue(page)
    await expect(queueSection(page, /next in queue/i).getByText('Do It Again')).toBeVisible()
    // ...and the context section now names the playlist it came from.
    await expect(page.getByRole('heading', { name: /next from: Seeded Playlist/i })).toBeVisible()
  })

  test('a queued track can be removed', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Play Beast of Burden', exact: true }).click()
    await page.getByRole('button', { name: 'Add Do It Again to queue' }).click()
    await openQueue(page)

    const manual = queueSection(page, /next in queue/i)
    await expect(manual.getByText('Do It Again')).toBeVisible()

    await manual.getByRole('button', { name: 'Remove Do It Again from the queue' }).click()

    await expect(manual.getByText(/nothing queued by hand/i)).toBeVisible()
    // Removing from the queue must not touch the library it came from. The
    // library context has no name, so its heading is the generic "Up next".
    await expect(queueSection(page, /up next/i).getByText('Do It Again')).toBeVisible()
  })

  test('the queue survives a reload', async ({ page }) => {
    await page.goto('/')

    await page.getByRole('button', { name: 'Play Beast of Burden', exact: true }).click()
    await page.getByRole('button', { name: 'Add Do It Again to queue' }).click()

    await page.reload()

    await openQueue(page)
    await expect(queueSection(page, /next in queue/i).getByText('Do It Again')).toBeVisible()
  })
})
