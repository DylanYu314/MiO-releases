import { isOnAddLink, resetSharedText, useSharedText } from '../src/library/sharedText'

/**
 * The one-shot handover from a share to the Add-link screen (#573).
 *
 * A share arrives at the root — as the launch intent, or through `onNewIntent`
 * — and the screen it belongs to may not be mounted. This is the gap between
 * them, and the whole of its design is that it is consumed rather than read.
 */

beforeEach(() => {
  resetSharedText()
})

it('hands the text over exactly once', () => {
  /*
   * ⚠️ The property that made this a store rather than a route parameter.
   * `expo-router` keeps a param across a re-render and a back-navigation, so
   * the Add-link box would re-fill with a link the user had already dealt with
   * every time they returned to the screen.
   */
  useSharedText.getState().offer('https://youtu.be/dQw4w9WgXcQ')

  expect(useSharedText.getState().take()).toBe('https://youtu.be/dQw4w9WgXcQ')
  expect(useSharedText.getState().take()).toBeNull()
})

it('is null when nothing was shared', () => {
  expect(useSharedText.getState().take()).toBeNull()
})

it('keeps the newest share when a second arrives first', () => {
  // Two shares before the screen mounts is a real sequence — the second is what
  // the user last asked for, and the first is stale.
  useSharedText.getState().offer('https://youtu.be/aaaaaaaaaaa')
  useSharedText.getState().offer('https://youtu.be/bbbbbbbbbbb')

  expect(useSharedText.getState().take()).toBe('https://youtu.be/bbbbbbbbbbb')
})

/**
 * Where the root must *not* navigate (#600).
 *
 * A share arriving while Add-link is already showing used to push a second,
 * empty copy over the filled one — `offer` had already been consumed by the
 * mounted screen, so the new instance had nothing to read. The box looked
 * empty and the shared link was underneath it.
 */
describe('isOnAddLink', () => {
  it('is true for the Add-link route under its tab group', () => {
    expect(isOnAddLink(['(tabs)', 'add', 'link'])).toBe(true)
  })

  it('is true regardless of what the group is called', () => {
    // Matched on the tail, so adding or renaming a group does not silently
    // turn the guard off and bring the duplicate screen back.
    expect(isOnAddLink(['(main)', '(tabs)', 'add', 'link'])).toBe(true)
  })

  it('is false on the Add chooser, which is where a share should navigate from', () => {
    expect(isOnAddLink(['(tabs)', 'add'])).toBe(false)
  })

  it('is false on a sibling Add screen', () => {
    // `add/local` and `add/bilibili` are not the share destination; a share
    // arriving there must still navigate.
    expect(isOnAddLink(['(tabs)', 'add', 'local'])).toBe(false)
  })

  it('is false on another tab', () => {
    expect(isOnAddLink(['(tabs)', 'library'])).toBe(false)
  })

  it('is false for a route merely ending in "link"', () => {
    expect(isOnAddLink(['(tabs)', 'settings', 'link'])).toBe(false)
  })

  it('is false at the root, where segments are empty', () => {
    expect(isOnAddLink([])).toBe(false)
  })
})

/**
 * The store half of #600, which was never broken and is pinned so a fix to the
 * navigation cannot be "helped" by changing this instead.
 */
it('a second offer replaces the first, so the newest share is the one taken', () => {
  useSharedText.getState().offer('https://youtu.be/first')
  useSharedText.getState().offer('https://youtu.be/second')

  expect(useSharedText.getState().take()).toBe('https://youtu.be/second')
  expect(useSharedText.getState().take()).toBeNull()
})
