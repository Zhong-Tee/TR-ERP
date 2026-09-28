import { describe, expect, it } from 'vitest'
import { calculateLeaveDeductionAmount, calculateMonthlyLeaveOverage, resolvePayrollLeaveDeduction, type LeaveDeductionRequest } from './payrollLeaveDeduction'

const unpaid = { id: 'unpaid', name: 'ลาไม่รับค่าจ้าง', is_paid: false, max_days_per_year: 10 }
const paid = { id: 'paid', name: 'ลากิจ', is_paid: true, max_days_per_year: 3 }
const leave = (overrides: Partial<LeaveDeductionRequest> = {}): LeaveDeductionRequest => ({
  id: 'leave-1', employee_id: 'employee-1', leave_type_id: unpaid.id, start_date: '2026-09-10',
  total_days: 1, status: 'approved', created_at: '2026-09-01T00:00:00Z', ...overrides,
})
const days = (requests: LeaveDeductionRequest[], openings: Parameters<typeof calculateMonthlyLeaveOverage>[3] = []) =>
  [...(calculateMonthlyLeaveOverage('2026-09', requests, [unpaid, paid], openings).get('employee-1')?.values() || [])].reduce((sum, value) => sum + value, 0)

describe('monthly approved leave deduction', () => {
  it('deducts one unpaid day at 15000 / 30 even when an unpaid leave limit exists', () => {
    expect(calculateLeaveDeductionAmount(15000, days([leave()]))).toBe(500)
  })
  it('does not charge paid leave within entitlement', () => {
    expect(days([leave({ leave_type_id: paid.id, total_days: 2 })])).toBe(0)
  })
  it('charges only the current month excess after previous paid leave uses entitlement', () => {
    expect(days([
      leave({ id: 'old', leave_type_id: paid.id, start_date: '2026-08-20', total_days: 2.5 }),
      leave({ leave_type_id: paid.id, total_days: 1 }),
    ])).toBe(0.5)
  })
  it('does not charge previous-month excess twice or include next-month leave', () => {
    expect(days([
      leave({ id: 'old', leave_type_id: paid.id, start_date: '2026-08-20', total_days: 4 }),
      leave({ leave_type_id: paid.id, total_days: 0.25 }),
      leave({ id: 'future', start_date: '2026-10-01', total_days: 2 }),
    ])).toBe(0.25)
  })
  it('uses opening entitlement and excludes leave before its effective date', () => {
    expect(days([
      leave({ id: 'old', leave_type_id: paid.id, start_date: '2026-08-20', total_days: 20 }),
      leave({ leave_type_id: paid.id, total_days: 1 }),
    ], [{ employee_id: 'employee-1', leave_type_id: paid.id, year: 2026, effective_date: '2026-09-01', opening_remaining_days: 0.5 }])).toBe(0.5)
  })
  it('excludes pending, rejected, cancelled, other-year and other-employee leave', () => {
    expect(days([
      leave({ status: 'pending' }), leave({ status: 'rejected' }), leave({ status: 'cancelled' }),
      leave({ start_date: '2025-09-10' }), leave({ employee_id: 'employee-2' }),
    ])).toBe(0)
  })
  it('supports hourly fractions and daily wages with currency rounding', () => {
    expect(calculateLeaveDeductionAmount(15000, days([leave({ total_days: 0.125 })]))).toBe(62.5)
    expect(calculateLeaveDeductionAmount(400, 0.5, 'daily')).toBe(200)
    expect(calculateLeaveDeductionAmount(16000, 1)).toBe(533.33)
  })
})

describe('payroll leave deduction refresh', () => {
  it('updates a saved zero deduction after a one-day 500 baht deduction becomes available', () => {
    expect(resolvePayrollLeaveDeduction('draft', 0, 500)).toEqual({ amount: 500, changed: true })
  })
  it('removes a draft deduction when the current source no longer includes it', () => {
    expect(resolvePayrollLeaveDeduction('draft', 500, undefined)).toEqual({ amount: 0, changed: true })
  })
  it('keeps review status when the deduction is unchanged', () => {
    expect(resolvePayrollLeaveDeduction('draft', 500, 500)).toEqual({ amount: 500, changed: false })
  })
  it('preserves confirmed payroll even when leave data changes', () => {
    expect(resolvePayrollLeaveDeduction('confirmed', 0, 500)).toEqual({ amount: 0, changed: false })
    expect(resolvePayrollLeaveDeduction('confirmed', 500, undefined)).toEqual({ amount: 500, changed: false })
  })
})
