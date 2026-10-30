import { describe, expect, it } from 'vitest'
import type { HREmployee } from '../types'
import { calculateMonthlyWage, compensationAt, sortCompensationHistory, type CompensationRecord } from './payrollCompensation'

const employee = { id: 'emp-24', contract_type: 'permanent', salary: 18000, hire_date: '2026-10-19', position_allowance: 0 } as HREmployee
const row = (effective_date: string, pay_type: 'daily' | 'permanent', salary: number, created_at = '2026-10-30T00:00:00Z'): CompensationRecord => ({ employee_id: employee.id, effective_date, pay_type, salary, created_at })

describe('effective monthly wages with a 30-day divisor', () => {
  it('pays EMP00024 7,800 for October 19–31 and retains the full rate of 18,000', () => {
    const summary = calculateMonthlyWage('2026-10', employee, [row('2026-10-19','permanent',18000)])
    expect(summary).toMatchObject({ monthlyRate: 18000, calendarDays: 13, payableDays: 13, baseSalary: 7800 })
    expect(summary.details).toEqual([{ startDate: '2026-10-19', endDate: '2026-10-31', monthlyRate: 18000, positionAllowance: 0, calendarDays: 13, payableDays: 13, amount: 7800, allowanceAmount: 0 }])
  })

  it.each(['2026-02','2028-02','2026-04','2026-10'])('pays the full monthly rate for a complete month (%s)', month => {
    const summary = calculateMonthlyWage(month, { ...employee, hire_date: '2020-01-01' }, [])
    expect(summary.baseSalary).toBe(18000)
    expect(summary.payableDays).toBe(30)
  })

  it('uses the later correction for the same effective date and does not mutate history', () => {
    const history = [row('2026-10-19','daily',600,'2026-10-19T00:00:00Z'),row('2026-10-19','permanent',18000)]
    expect(compensationAt(employee,sortCompensationHistory(history),'2026-10-19').payType).toBe('permanent')
    expect(calculateMonthlyWage('2026-10',employee,history).baseSalary).toBe(7800)
    expect(history[0].pay_type).toBe('daily')
  })

  it('does not create monthly days before a mid-month switch from daily', () => {
    const summary = calculateMonthlyWage('2026-10',{ ...employee, hire_date: '2026-10-01' },[row('2026-10-01','daily',600),row('2026-10-19','permanent',18000)])
    expect(summary.calendarDays).toBe(13)
    expect(summary.details[0].startDate).toBe('2026-10-19')
  })

  it('retains a historical monthly period after the registry changes to daily', () => {
    const summary = calculateMonthlyWage('2026-10',{ ...employee, contract_type: 'daily', salary: 600, hire_date: '2026-10-01' },[row('2026-10-01','permanent',18000),row('2026-10-20','daily',600)])
    expect(summary.baseSalary).toBe(11400)
    expect(summary.details[0].endDate).toBe('2026-10-19')
  })

  it('excludes dates after the contract ends and before hiring', () => {
    expect(calculateMonthlyWage('2026-10',{ ...employee, contract_end_date: '2026-10-25' },[]).baseSalary).toBe(4200)
    expect(calculateMonthlyWage('2026-09',employee,[]).baseSalary).toBe(0)
  })

  it('does not apply a future monthly rate to an earlier daily period', () => {
    expect(calculateMonthlyWage('2026-10',{ ...employee, contract_type: 'daily', salary: 600 },[row('2026-10-19','daily',600),row('2026-11-01','permanent',18000)]).baseSalary).toBe(0)
  })
})
