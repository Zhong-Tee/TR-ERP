import { describe, expect, it } from 'vitest'
import { calculateEmployeeLeaveBalances, resolveLeaveEntitlement } from './leaveEntitlement'
import { calculateMonthlyLeaveOverage, resolvePayrollLeaveDeduction } from './payrollLeaveDeduction'

const types = [{ id: 'personal', name: 'ลากิจ', max_days_per_year: 5, is_paid: true }, { id: 'sick', name: 'ลาป่วย', max_days_per_year: 30, is_paid: true }, { id: 'vacation', name: 'ลาพักร้อน', max_days_per_year: 6, is_paid: true }]
const openings = types.map(t => ({ employee_id: 'emp', leave_type_id: t.id, year: 2026, effective_date: '2026-10-01', opening_remaining_days: t.id === 'vacation' ? 0 : t.max_days_per_year }))
const leave = (id: string, type: string, date: string, days = 1, status = 'approved') => ({ id, employee_id: 'emp', leave_type_id: type, start_date: date, total_days: days, status: status as 'approved', created_at: `${date}T00:00:00Z` })
const requests = [leave('old-sick', 'sick', '2026-08-31'), leave('old-personal', 'personal', '2026-09-26', 0.1), leave('sick', 'sick', '2026-10-09'), leave('personal', 'personal', '2026-10-25')]
describe('personal leave rights shared between HR and payroll', () => {
  it('EMP00021 scenario: starts 5/30 on October 1, excludes daily-worker history and does not deduct October salary', () => {
    const rows = calculateEmployeeLeaveBalances('emp', '2026-10-26', types, requests, openings)
    expect(rows.find(r => r.id === 'personal')).toMatchObject({ entitled: 5, used: 1, remaining: 4 })
    expect(rows.find(r => r.id === 'sick')).toMatchObject({ entitled: 30, used: 1, remaining: 29 })
    expect(calculateMonthlyLeaveOverage('2026-10', requests, types, openings).size).toBe(0)
  })
  it('EMP00022 scenario: no October leave retains full 5/30 rights', () => {
    const rows = calculateEmployeeLeaveBalances('emp', '2026-10-26', types, requests.slice(0, 2), openings)
    expect(rows.find(r => r.id === 'personal')?.remaining).toBe(5)
    expect(rows.find(r => r.id === 'sick')?.remaining).toBe(30)
  })
  it('EMP00023 scenario: a personal zero overrides company vacation default 6', () => {
    expect(resolveLeaveEntitlement('emp', types[2], '2026-12-03', openings).entitled).toBe(0)
    expect(calculateEmployeeLeaveBalances('emp', '2026-10-26', types, [leave('pending', 'vacation', '2026-12-03', 2, 'pending')], openings).find(r => r.id === 'vacation')?.used).toBe(0)
  })
  it('a future opening date must not erase prior-period usage or deductions', () => {
    const prior = [leave('prior', 'personal', '2026-09-10', 6)]
    expect(resolveLeaveEntitlement('emp', types[0], '2026-09-30', openings).personal).toBe(false)
    expect(calculateMonthlyLeaveOverage('2026-09', prior, types, openings).get('emp')?.get('ลากิจ')).toBe(1)
  })
  it('counts only the monthly increment beyond personal rights and excludes cancelled and pending leave', () => {
    const rows = [...requests, leave('more', 'personal', '2026-11-01', 5), leave('pending', 'personal', '2026-11-03', 10, 'pending'), leave('cancelled', 'sick', '2026-11-03', 50, 'cancelled')]
    expect(calculateMonthlyLeaveOverage('2026-11', rows, types, openings).get('emp')?.get('ลากิจ')).toBe(1)
  })
  it('does not borrow another employee or year entitlement', () => {
    expect(resolveLeaveEntitlement('other', types[2], '2026-10-26', openings).entitled).toBe(6)
    expect(resolveLeaveEntitlement('emp', types[2], '2027-01-01', openings).entitled).toBe(6)
  })
  it('refreshes draft deductions while retaining every confirmed snapshot amount', () => {
    expect(resolvePayrollLeaveDeduction('draft', 500, 0)).toEqual({ amount: 0, changed: true })
    expect(resolvePayrollLeaveDeduction('confirmed', 500, 0)).toEqual({ amount: 500, changed: false })
    expect(resolvePayrollLeaveDeduction('confirmed', 0, 500)).toEqual({ amount: 0, changed: false })
  })
})
