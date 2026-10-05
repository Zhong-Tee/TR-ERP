import { describe, expect, it } from 'vitest'
import { bangkokDateKey, confirmBoardDefaultStart } from './confirmBoardDates'

describe('Confirm board default dates', () => {
  it('starts at month beginning when no older pending work exists', () => {
    expect(confirmBoardDefaultStart(null, '2026-10-05')).toBe('2026-10-01')
    expect(confirmBoardDefaultStart('2026-10-03T00:00:00Z', '2026-10-05')).toBe('2026-10-01')
  })
  it('includes the oldest pending work from previous months', () => {
    expect(confirmBoardDefaultStart('2026-08-15T03:00:00Z', '2026-10-05')).toBe('2026-08-15')
  })
  it('uses Bangkok dates at the month and day boundary', () => {
    expect(confirmBoardDefaultStart('2026-09-30T18:00:00Z', '2026-10-05')).toBe('2026-10-01')
    expect(bangkokDateKey('2026-10-04T18:00:00Z')).toBe('2026-10-05')
  })
})
