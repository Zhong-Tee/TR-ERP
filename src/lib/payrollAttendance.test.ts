import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HREmployee } from '../types'

const mock = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]>, errors: {} as Record<string, { message: string }> }))
vi.mock('./supabase', () => ({ supabase: {
  from: (table: string) => {
    const query: Record<string, unknown> = {}
    for (const name of ['select', 'in', 'gte', 'lt', 'lte', 'order', 'eq', 'range']) query[name] = () => query
    query.then = (resolve: (value: unknown) => void) => resolve({ data: mock.rows[table] || [], error: mock.errors[table] || null })
    return query
  },
} }))

import { applyDailyWageApproval, fetchDailyWageSummaries, fetchMonthlyWageSummaries, fetchPayrollOvertime, type DailyWageApproval, type DailyWageDetail } from './payrollApi'

const employee = { id: 'emp-24', employee_code: 'EMP00024', contract_type: 'daily', salary: 600, hire_date: '2026-10-19', contract_end_date: '2026-10-20' } as HREmployee
const approval = (work_date: string, payable_day = 1): DailyWageApproval => ({
  id: `approval-${work_date}`, appeal_id: `appeal-${work_date}`, employee_id: employee.id,
  work_date, payable_day, note: 'HR verified attendance',
})

beforeEach(() => { mock.rows = {}; mock.errors = {} })

describe('daily payroll attendance approvals', () => {
  it('pays both approved days in EMP00024 without fabricating clock times', async () => {
    mock.rows.hr_daily_wage_approvals = [approval('2026-10-19'), approval('2026-10-20')]
    const result = (await fetchDailyWageSummaries('2026-10', [employee]))[employee.id]
    expect(result.regularPay).toBe(1200)
    expect(result.payableDays).toBe(2)
    expect(result.details).toHaveLength(2)
    expect(result.details[0]).toMatchObject({ status: 'worked_full', amount: 600, approvalId: 'approval-2026-10-19', clockIn: null, clockOut: null })
  })

  it('pays half days and counts each date once even with complete clock entries', async () => {
    mock.rows.hr_daily_wage_approvals = [approval('2026-10-19', 0.5)]
    mock.rows.hr_time_entries = [
      { employee_id: employee.id, work_date: '2026-10-19', entry_type: 'clock_in', entry_time: '2026-10-19T01:30:00Z' },
      { employee_id: employee.id, work_date: '2026-10-19', entry_type: 'clock_out', entry_time: '2026-10-19T10:30:00Z' },
    ]
    const result = (await fetchDailyWageSummaries('2026-10', [employee]))[employee.id]
    expect(result.regularPay).toBe(300)
    expect(result.halfDays).toBe(1)
    expect(result.details[1]).toMatchObject({ status: 'absent', amount: 0 })
  })

  it('does not pay a score waiver lacking a wage approval', async () => {
    const result = (await fetchDailyWageSummaries('2026-10', [employee]))[employee.id]
    expect(result.regularPay).toBe(0)
    expect(result.details.every(detail => detail.status === 'absent')).toBe(true)
  })

  it('uses historical daily rates after the employee becomes monthly', async () => {
    mock.rows.hr_daily_wage_approvals = [approval('2026-10-19'), approval('2026-10-20')]
    mock.rows.hr_salary_history = [
      { employee_id: employee.id, effective_date: '2026-10-21', pay_type: 'permanent', salary: 18000 },
      { employee_id: employee.id, effective_date: '2026-10-19', pay_type: 'daily', salary: 600 },
    ]
    const result = (await fetchDailyWageSummaries('2026-10', [{ ...employee, contract_type: 'permanent', salary: 18000 }]))[employee.id]
    expect(result.regularPay).toBe(1200)
    expect(result.dailyRate).toBe(600)
  })

  it('preserves paid holiday rules and avoids a second payment for an approval', async () => {
    mock.rows.hr_daily_wage_approvals = [approval('2026-10-19')]
    mock.rows.hr_company_holidays = [{ holiday_date: '2026-10-19', name: 'Company holiday' }]
    const result = (await fetchDailyWageSummaries('2026-10', [employee]))[employee.id]
    expect(result.regularPay).toBe(600)
    expect(result.paidHolidayDays).toBe(1)
    expect(result.fullDays).toBe(0)
  })

  it('fails visibly when approvals cannot be read instead of silently withholding wages', async () => {
    mock.errors.hr_daily_wage_approvals = { message: 'Approval query failed' }
    await expect(fetchDailyWageSummaries('2026-10', [employee])).rejects.toThrow('Approval query failed')
  })

  it('rejects invalid day fractions and approvals for another date', () => {
    const detail = { workDate: '2026-10-19', dailyRate: 600 } as DailyWageDetail
    expect(() => applyDailyWageApproval(detail, approval('2026-10-19', 2))).toThrow()
    expect(() => applyDailyWageApproval(detail, approval('2026-10-20'))).toThrow()
  })

  it('uses one corrected timeline for both payrolls and never pays the monthly period as daily again', async () => {
    const current = { ...employee, contract_type: 'permanent' as const, salary: 18000, contract_end_date: null }
    mock.rows.hr_salary_history = [
      { id: 'new', employee_id: employee.id, effective_date: '2026-10-19', pay_type: 'permanent', salary: 18000, created_at: '2026-10-30T00:00:00Z' },
      { id: 'old', employee_id: employee.id, effective_date: '2026-10-19', pay_type: 'daily', salary: 600, created_at: '2026-10-19T00:00:00Z' },
    ]
    mock.rows.hr_daily_wage_approvals = [approval('2026-10-19'),approval('2026-10-20')]
    const daily = (await fetchDailyWageSummaries('2026-10',[current]))[current.id]
    const monthly = (await fetchMonthlyWageSummaries('2026-10',[current]))[current.id]
    expect(daily.details).toEqual([])
    expect(daily.regularPay).toBe(0)
    expect(monthly.baseSalary).toBe(7800)
    expect(monthly.monthlyRate).toBe(18000)
  })

  it('splits OT by the effective daily/monthly date so the two payrolls cannot both pay it', async () => {
    const current = { ...employee, contract_type: 'permanent' as const, salary: 18000, hire_date: '2026-10-01', contract_end_date: null }
    mock.rows.hr_salary_history = [
      { employee_id: employee.id, effective_date: '2026-10-19', pay_type: 'permanent', salary: 18000 },
      { employee_id: employee.id, effective_date: '2026-10-01', pay_type: 'daily', salary: 600 },
    ]
    mock.rows.hr_ot_requests = ['2026-10-18','2026-10-19'].map(request_date => ({ employee_id: employee.id, request_date, hours: 1, ot_start: '17:00', ot_end: '18:00' }))
    mock.rows.hr_time_entries = ['2026-10-18','2026-10-19'].flatMap(work_date => [
      { employee_id: employee.id, work_date, entry_type: 'ot_in', entry_time: `${work_date}T10:00:00Z` },
      { employee_id: employee.id, work_date, entry_type: 'ot_out', entry_time: `${work_date}T11:00:00Z` },
    ])
    expect((await fetchPayrollOvertime('2026-10',[current],'permanent'))[current.id].overtimePay).toBe(112.5)
    expect((await fetchPayrollOvertime('2026-10',[current],'daily'))[current.id].overtimePay).toBe(112.5)
  })
})
