import { describe, expect, it } from 'vitest'
import { canAcceptManpowerAssignment } from './planAssignmentCapacity'

describe('canAcceptManpowerAssignment', () => {
  it('allows touching jobs and overlaps up to five minutes at capacity one', () => {
    expect(canAcceptManpowerAssignment([{ start: 60, end: 120 }], { start: 120, end: 150 }, 1)).toBe(true)
    expect(canAcceptManpowerAssignment([{ start: 60, end: 125 }], { start: 120, end: 150 }, 1)).toBe(true)
  })

  it('blocks an overlap longer than five minutes at capacity one', () => {
    expect(canAcceptManpowerAssignment([{ start: 60, end: 126 }], { start: 120, end: 150 }, 1)).toBe(false)
  })

  it('allows two simultaneous assignments when capacity is two', () => {
    expect(canAcceptManpowerAssignment([{ start: 60, end: 150 }], { start: 90, end: 120 }, 2)).toBe(true)
    expect(canAcceptManpowerAssignment([
      { start: 60, end: 150 },
      { start: 80, end: 130 },
    ], { start: 90, end: 120 }, 2)).toBe(false)
  })

  it('does not add disjoint overlaps together as simultaneous load', () => {
    expect(canAcceptManpowerAssignment([
      { start: 60, end: 90 },
      { start: 110, end: 140 },
    ], { start: 70, end: 130 }, 2)).toBe(true)
  })
})
