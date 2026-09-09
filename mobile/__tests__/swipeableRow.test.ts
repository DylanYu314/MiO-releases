import { swipeTravel } from '../src/components/SwipeableRow'

/**
 * How far a swipe has to go (#316, #379).
 *
 * These lived in `songRow.test.tsx` until the component moved: #379 generalised
 * the gesture out of `SongRow` into `SwipeableRow`, so the library's
 * swipe-right and the queue's swipe-left could not drift apart, and the tests
 * stayed behind. `songRow.test.tsx` still covers the *row*, gesture included.
 */

/**
 * Swipe a row right to queue it (#316).
 *
 * The composition is ADR-018's, and it is the fourth thing that ADR has
 * answered: `activeOffsetX` claims sideways movement and `failOffsetY` yields
 * downward movement, so the list still scrolls. Its neighbour on these rows —
 * `DraggableList`'s drag — is separated by *time* rather than axis, so the two
 * never contend for the same touch.
 *
 * The decision is a pure function, tested as one, because jest cannot see a
 * finger and every distance in a gesture test is invented by the test.
 */
describe('how far a swipe has to go', () => {
  it('does nothing until the row has travelled a real distance', () => {
    // A wobble during a scroll is not a queue.
    expect(swipeTravel(20).commits).toBe(false)
    expect(swipeTravel(95).commits).toBe(false)
  })

  it('commits once it has', () => {
    expect(swipeTravel(96).commits).toBe(true)
    expect(swipeTravel(300).commits).toBe(true)
  })

  it('ignores a leftward drag entirely', () => {
    // Somebody scrolling a horizontal list, or reaching for the back gesture.
    // Inventing a second action for it would make the row do two things nobody
    // asked for.
    expect(swipeTravel(-200)).toEqual({ offset: 0, commits: false })
  })

  it('stops the row travelling off the screen', () => {
    expect(swipeTravel(1000).offset).toBe(128)
  })
})

/**
 * The same decider, pointed the other way (#379).
 *
 * The queue swipes **left** to remove. One function rather than two, because
 * two would drift — the commit distance is a feel decision and having it in two
 * places means changing it in one.
 */
describe('a leftward swipe', () => {
  it('travels negative, so the caller can hand the offset to a transform', () => {
    expect(swipeTravel(-100, 'left').offset).toBe(-100)
  })

  it('commits at the same distance, measured the other way', () => {
    expect(swipeTravel(-95, 'left').commits).toBe(false)
    expect(swipeTravel(-96, 'left').commits).toBe(true)
  })

  it('ignores a rightward drag on a left-swiping row', () => {
    // The mirror of the rule above: a row that travels both ways implies two
    // actions, and only one is on offer.
    expect(swipeTravel(200, 'left')).toEqual({ offset: 0, commits: false })
  })

  it('stops at the same limit', () => {
    expect(swipeTravel(-1000, 'left').offset).toBe(-128)
  })
})
