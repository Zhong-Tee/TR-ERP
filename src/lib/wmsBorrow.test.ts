import { describe, expect, it } from 'vitest'
import { borrowDefaultStartDate, borrowLocalDate, isBorrowOverdue } from './wmsBorrow'

describe('borrow default date range', () => {
  const now = new Date(2026, 9, 6)

  it('starts on the first of this month without older outstanding loans', () => {
    expect(borrowDefaultStartDate(null, now)).toBe('2026-10-01')
    expect(borrowDefaultStartDate(new Date(2026, 9, 4).toISOString(), now)).toBe('2026-10-01')
  })

  it('includes the oldest outstanding loan across months and years', () => {
    expect(borrowDefaultStartDate(new Date(2026, 8, 16).toISOString(), now)).toBe('2026-09-16')
    expect(borrowDefaultStartDate(new Date(2025, 11, 31).toISOString(), now)).toBe('2025-12-31')
  })

  it('uses the local calendar date at midnight', () => {
    expect(borrowLocalDate(new Date(2026, 9, 1, 0, 5))).toBe('2026-10-01')
  })
})

describe('overdue borrow count conditions', () => {
  it('includes outstanding statuses only after the due date', () => {
    for (const status of ['pending', 'approved', 'partial_returned', 'overdue']) {
      expect(isBorrowOverdue('2026-10-05', status, '2026-10-06')).toBe(true)
      expect(isBorrowOverdue('2026-10-06', status, '2026-10-06')).toBe(false)
      expect(isBorrowOverdue('2026-10-07', status, '2026-10-06')).toBe(false)
    }
  })

  it('excludes returned, written off, and rejected loans', () => {
    for (const status of ['returned', 'written_off', 'rejected']) {
      expect(isBorrowOverdue('2026-09-16', status, '2026-10-06')).toBe(false)
    }
  })
})
