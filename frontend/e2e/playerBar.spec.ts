import { expect, test } from '@playwright/test'

/**
 * #126: the player bar's control row spilled its container between 640px and
 * ~768px — measured at 637px of content in a 628px container at a 660px
 * viewport, clipping whatever sat at the end of the row.
 *
 * A bug defined by a measurement deserves a test that measures. Asserting on
 * class names would pass against any arrangement that happened to keep them,
 * including one that still overflows.
 */

/** Widths that were broken, plus the ones either side that were not. */
const WIDTHS = [640, 660, 700, 767, 768, 900]

async function startPlayback(page: import('@playwright/test').Page) {
  await page.goto('/')
  // The bar only exists once something is playing.
  await page
    .getByRole('button', { name: /^Play / })
    .first()
    .click()
  await expect(page.getByTestId('player-bar-controls')).toBeVisible()
}

test.describe('player bar layout (#126)', () => {
  for (const width of WIDTHS) {
    test(`control row fits its container at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await startPlayback(page)

      const overflow = await page.getByTestId('player-bar-controls').evaluate((element) => ({
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      }))

      // scrollWidth > clientWidth is precisely "there is content you cannot see".
      expect(
        overflow.scrollWidth,
        `content ${overflow.scrollWidth}px in a ${overflow.clientWidth}px container`,
      ).toBeLessThanOrEqual(overflow.clientWidth)
    })
  }
})
