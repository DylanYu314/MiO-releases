import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { liftedRowStyle } from '../src/components/DraggableList'

/**
 * A row being dragged has to *look* dragged (#448).
 *
 * *"when a track is selected to drag, make its background darker or
 * greyed out, so user know this track is selected"*. It was `opacity: 0.9` and
 * nothing else — a change small enough that I could not tell which row I had
 * hold of.
 *
 * ## Why the decision is a function
 *
 * Because it is the only part of the drag a test can reach.
 * `fireGestureHandler` completes a gesture as it dispatches it, so the row is
 * dropped before the rendered tree can be read and the transient style is not
 * observable through that harness at all. Asserting on the decision is honest;
 * asserting on a style that only exists for a frame nobody can catch is not.
 */

const theme = { surfacePressed: '#2a2a2a' }

describe('how a dragged row is drawn', () => {
  it('fills the row with the pressed token', () => {
    // `surfacePressed` and not a colour of its own: #378 made one token mean
    // "a finger is on this", and a drag is the longest press there is.
    expect(liftedRowStyle(true, theme)).toEqual({ opacity: 0.9, backgroundColor: '#2a2a2a' })
  })

  it('leaves a row that is not being dragged completely alone', () => {
    // `null`, not an empty object: the row is drawn by the caller against
    // whatever the screen uses, and a background of `undefined` written over it
    // would still be a background written over it.
    expect(liftedRowStyle(false, theme)).toBeNull()
  })

  it('keeps the fill and the fade together', () => {
    // The fade alone is what shipped, and it is what I could not see. If
    // either half is dropped this fails, which is the point of asserting both
    // in one object rather than two loose properties.
    const style = liftedRowStyle(true, theme)
    expect(style?.backgroundColor).toBe('#2a2a2a')
    expect(style?.opacity).toBeLessThan(1)
  })
})

/**
 * …and that it is actually applied to the row.
 *
 * The decision above can be perfect and reach nothing. Deleting the call from
 * the row's style array leaves every test in this file passing, because they
 * all exercise the function directly — which is the "tested the helper, not the
 * call site" gap, and the reason this reads the source.
 *
 * **Comments are stripped first.** #303 shipped a source-reading guard that
 * passed against broken code because the word it looked for survived in the
 * docblock explaining it. Asserting on prose is not asserting on behaviour.
 */
describe('the row actually uses it', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'components', 'DraggableList.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  it('calls it from the row style, not just exports it', () => {
    // The call, with its arguments — `liftedRowStyle` appearing anywhere would
    // also match its own declaration.
    expect(source).toMatch(/liftedRowStyle\(isDragging,\s*theme\)/)
  })

  it('no longer carries the fade-only style it replaced', () => {
    // `styles.lifted` was `opacity: 0.9` and nothing else. Leaving it behind
    // would be a second answer to the same question, and the one I could
    // not see.
    expect(source).not.toMatch(/styles\.lifted/)
  })
})
