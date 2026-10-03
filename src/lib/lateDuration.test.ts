import { describe, expect, it } from 'vitest'
import { lateDurationMinutes } from './lateDuration'

describe('grace period policy', () => {
  it('does not count arrivals through 09:35 as late for a 09:30 start with five minutes grace', () => {
    for (const actual of [569, 570, 574, 575]) expect(lateDurationMinutes(actual, 570, 5)).toBe(0)
  })
  it('counts from 09:30 after grace is exceeded', () => {
    expect(lateDurationMinutes(576, 570, 5)).toBe(6)
    expect(lateDurationMinutes(580, 570, 5)).toBe(10)
  })
  it('counts the full delay without grace', () => {
    expect(lateDurationMinutes(571, 570, 0)).toBe(1)
  })
})
