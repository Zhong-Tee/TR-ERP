import { describe, expect, it } from 'vitest'
import { getUrgencyBadge } from './shipDueBadge'

describe('getUrgencyBadge', () => {
  const due = {
    ship_due_at: '2026-09-05T16:59:00.000Z',
    overdue_at: '2026-09-05T17:00:00.000Z',
  }

  it('stops at shipped_time even when the consumer uses a different status vocabulary', () => {
    expect(getUrgencyBadge({
      ...due,
      status: 'pending',
      shipped_time: '2026-09-04T10:00:00.000Z',
    }, new Date('2026-09-07T10:00:00.000Z'))).toBeNull()
  })

  it('keeps calculating against current time while the order has not shipped', () => {
    expect(getUrgencyBadge(due, new Date('2026-09-07T10:00:00.000Z'))).toBe('overdue')
  })

  it('preserves overdue when the order was already late at shipment time', () => {
    expect(getUrgencyBadge({
      ...due,
      shipped_time: '2026-09-06T10:00:00.000Z',
    }, new Date('2026-09-07T10:00:00.000Z'))).toBe('overdue')
  })
})
