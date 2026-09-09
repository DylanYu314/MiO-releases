import { describe, expect, it } from 'vitest'

import { formatDuration } from './format'

describe('formatDuration', () => {
  it('formats seconds as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(266)).toBe('4:26')
  })

  it('includes hours only when the track is long enough', () => {
    expect(formatDuration(3599)).toBe('59:59')
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3725)).toBe('1:02:05')
  })

  it('rounds fractional seconds', () => {
    expect(formatDuration(19.6)).toBe('0:20')
  })

  it('falls back to a placeholder for unknown or invalid durations', () => {
    expect(formatDuration(null)).toBe('--:--')
    expect(formatDuration(-5)).toBe('--:--')
    expect(formatDuration(Number.NaN)).toBe('--:--')
  })
})
