import { formatDuration } from '../src/api/songs'

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [61, '1:01'],
    [222.5, '3:43'],
    [3600, '60:00'],
  ])('renders %p as %p', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })

  it('renders an unknown duration as a dash, not 0:00', () => {
    // "0:00" would read as a real length, and a song with no measured duration
    // is not a zero-length song.
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
