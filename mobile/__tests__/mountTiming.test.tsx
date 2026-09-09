import { act, render, waitFor } from '@testing-library/react-native'
import { Text } from 'react-native'

import { useDiagnostics } from '../src/diagnostics/log'
import { formatMountSample, resetMountCounts, useMountTiming } from '../src/diagnostics/mountTiming'

/**
 * The instrument for #503, and only the instrument.
 *
 * I reported the queue screen opening slowly and guessed at caching. There
 * is nothing to cache — the screen reads the in-memory store — so what is
 * needed is the number that separates the remaining candidates, not a fix.
 *
 * **What is worth pinning is that it can print the other answer.** An
 * instrument that could only ever report the result it reported has measured
 * nothing (#371), so these assert on a *fast* mount and a *slow* one
 * separately, and on the open counter that is the whole point of it.
 */

function Probe({ detail = 'userQueue=0 context=0' }: { detail?: string }) {
  useMountTiming('queue', detail)
  return <Text>probe</Text>
}

/** The `queue.mount` lines written so far, oldest first. */
function lines(): string[] {
  return useDiagnostics
    .getState()
    .entries.filter((entry) => entry.event === 'queue.mount')
    .map((entry) => entry.detail ?? '')
}

beforeEach(async () => {
  // Drain any frame still pending from the previous test *before* clearing.
  // The hook deliberately does not cancel its callback on unmount (losing the
  // sample is worse than a late line), so without this a stray `queue.mount`
  // from the test before lands in this one's freshly emptied log.
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  resetMountCounts()
  // Wrapped, because `useDiagnostics` is `persist`-wrapped: mutating one of
  // those outside `act` is written up in docs/lessons.md as breaking the *next*
  // test rather than this one.
  await act(async () => {
    useDiagnostics.setState({ entries: [] })
  })
})

describe('the sample line', () => {
  it('reports a fast mount as a small number', () => {
    expect(formatMountSample(1, 12, 18, 'userQueue=3 context=40')).toBe(
      'open=1 toCommit=12ms toFrame=18ms userQueue=3 context=40',
    )
  })

  it('reports a slow mount as a large one', () => {
    // The other answer. Without this the formatter could be hard-coding the
    // shape of a healthy reading and nobody would know.
    expect(formatMountSample(2, 624, 710, 'userQueue=3 context=40')).toBe(
      'open=2 toCommit=624ms toFrame=710ms userQueue=3 context=40',
    )
  })

  it('rounds rather than printing a fraction nobody can act on', () => {
    expect(formatMountSample(1, 12.4, 18.6, 'x=1')).toBe('open=1 toCommit=12ms toFrame=19ms x=1')
  })
})

describe('measuring a mount', () => {
  it('writes one line per mount', async () => {
    await render(<Probe />)

    // The sample lands on the frame after commit, which is the point of it —
    // so the wait is part of what is being asserted, not test scaffolding.
    await waitFor(() => expect(lines()).toHaveLength(1))
    expect(lines()[0]).toMatch(/^open=1 toCommit=\d+ms toFrame=\d+ms userQueue=0 context=0$/)
  })

  it('counts opens, which is the reading the issue turns on', async () => {
    // Two mounts, not an unmount and a remount: calling `unmount()` by hand on
    // top of the library's own cleanup breaks the *next* test's render, and the
    // counter does not care whether the first tree is still standing.
    await render(<Probe />)
    await render(<Probe />)

    // "Is the second open much faster than the first" cannot be answered
    // without knowing which open produced which number.
    await waitFor(() => expect(lines()).toHaveLength(2))
    expect(lines()[0]).toContain('open=1')
    expect(lines()[1]).toContain('open=2')
  })

  it('survives the log de-duplicating identical lines', async () => {
    // #371: the log drops an immediate repeat with the same detail, which would
    // erase the second open — the one the whole exercise is for. The counter is
    // what keeps the two details different.
    await render(<Probe />)
    await render(<Probe />)

    await waitFor(() => expect(lines()).toHaveLength(2))
    const [a, b] = lines()
    expect(a).not.toEqual(b)
  })

  it('carries the counts that separate the remaining candidates', async () => {
    await render(<Probe detail="userQueue=5 context=480" />)

    // Flat in these means the route; rising with them means the lists.
    await waitFor(() => expect(lines()[0]).toContain('userQueue=5 context=480'))
  })

  it('logs nothing more when the component re-renders', async () => {
    const view = await render(<Probe />)
    await waitFor(() => expect(lines()).toHaveLength(1))

    await act(async () => {
      // A *different* detail, so an effect wrongly keyed on it would re-run.
      view.rerender(<Probe detail="userQueue=1 context=0" />)
    })

    // Drain two frames, because the sample is frame-delayed: asserting straight
    // after the re-render would pass against a hook that logs on every render
    // and simply had not got there yet. Without this wait the mutation
    // survives — it did.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })

    // The sample is of the first mount. A line per render would measure
    // something else entirely and drown the reading in noise.
    expect(lines()).toHaveLength(1)
  })
})
