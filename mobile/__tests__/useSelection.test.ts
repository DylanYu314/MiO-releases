import { act, renderHook } from '@testing-library/react-native'

import { useSelection } from '../src/components/useSelection'

/**
 * The state machine behind selection mode (#336).
 *
 * Pure state, so it is tested as state rather than through a screen — the two
 * screens draw it differently and both would otherwise be testing this twice.
 */

describe('selection mode', () => {
  it('is off until it is started, and rows are not selectable', async () => {
    const { result } = await renderHook(() => useSelection())

    expect(result.current.active).toBe(false)
    // `undefined`, not `false` — which is what `SongRow` reads as "no tick at
    // all". Returning false would put an empty circle on every row in the app.
    expect(result.current.stateFor('a')).toBeUndefined()
  })

  it('starts empty, and rows become selectable', async () => {
    const { result } = await renderHook(() => useSelection())

    await act(async () => {
      result.current.begin()
    })

    expect(result.current.active).toBe(true)
    expect(result.current.count).toBe(0)
    expect(result.current.stateFor('a')).toBe(false)
  })

  it('toggles one id on and off again', async () => {
    const { result } = await renderHook(() => useSelection())
    await act(async () => {
      result.current.begin()
    })

    await act(async () => {
      result.current.toggle('a')
    })
    expect(result.current.stateFor('a')).toBe(true)
    expect(result.current.count).toBe(1)

    await act(async () => {
      result.current.toggle('a')
    })
    expect(result.current.stateFor('a')).toBe(false)
    expect(result.current.count).toBe(0)
  })

  it('selects everything, then clears when everything is already selected', async () => {
    const { result } = await renderHook(() => useSelection())
    await act(async () => {
      result.current.begin()
    })

    await act(async () => {
      result.current.toggleAll(['a', 'b', 'c'])
    })
    expect(result.current.count).toBe(3)

    await act(async () => {
      result.current.toggleAll(['a', 'b', 'c'])
    })
    expect(result.current.count).toBe(0)
  })

  it('forgets the selection on the way out', async () => {
    // So re-entering never inherits a selection the user cannot see.
    const { result } = await renderHook(() => useSelection())
    await act(async () => {
      result.current.begin()
    })
    await act(async () => {
      result.current.toggle('a')
    })

    await act(async () => {
      result.current.end()
    })
    await act(async () => {
      result.current.begin()
    })

    expect(result.current.count).toBe(0)
  })

  it('drops ids that no longer exist', async () => {
    // The list changes underneath: a track is deleted, or a search filters it
    // out. A stale id keeps being counted, so the bar promises songs that are
    // not there and Delete acts on nothing.
    const { result } = await renderHook(() => useSelection())
    await act(async () => {
      result.current.begin()
    })
    await act(async () => {
      result.current.toggleAll(['a', 'b', 'c'])
    })

    await act(async () => {
      result.current.prune(['a', 'c'])
    })

    expect(result.current.count).toBe(2)
    expect(result.current.stateFor('b')).toBe(false)
  })

  it('keeps the same set when pruning changes nothing', async () => {
    /*
     * Identity, not just contents. `prune` runs from an effect on every list
     * settle, and a new Set each time would re-render every row of a list that
     * can be hundreds long — the class of fault #342 is open about.
     */
    const { result } = await renderHook(() => useSelection())
    await act(async () => {
      result.current.begin()
    })
    await act(async () => {
      result.current.toggleAll(['a', 'b'])
    })
    const before = result.current.ids

    await act(async () => {
      result.current.prune(['a', 'b', 'c'])
    })

    expect(result.current.ids).toBe(before)
  })
})
