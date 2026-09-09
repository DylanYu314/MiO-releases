import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useSelection } from './useSelection'

describe('useSelection', () => {
  it('toggles an id on and off', () => {
    const { result } = renderHook(() => useSelection<number>())

    act(() => result.current.toggle(1))
    expect(result.current.isSelected(1)).toBe(true)
    expect(result.current.count).toBe(1)

    act(() => result.current.toggle(1))
    expect(result.current.isSelected(1)).toBe(false)
    expect(result.current.count).toBe(0)
  })

  it('replaces the whole selection with set and empties it with clear', () => {
    const { result } = renderHook(() => useSelection<number>())

    act(() => result.current.set([1, 2, 3]))
    expect([...result.current.ids].sort()).toEqual([1, 2, 3])

    act(() => result.current.clear())
    expect(result.current.count).toBe(0)
  })
})
