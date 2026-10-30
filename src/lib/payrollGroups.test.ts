import { describe, expect, it } from 'vitest'
import { appendMissingMonthlyEmployees, monthlyPayrollGroup, payrollSocialSecurityEnabled } from './payrollGroups'
import type { PayrollItem } from './payrollApi'
import type { HREmployee } from '../types'

const item = (id: string, enabled: boolean | null, deduction: number, pay_type: 'permanent' | 'daily' = 'permanent') => ({
  employee_id: id, social_security_enabled: enabled, social_security: deduction, pay_type,
}) as PayrollItem

describe('monthly payroll groups', () => {
  it('uses the enrollment snapshot even when an enrolled employee has zero wages/deduction', () => {
    expect(payrollSocialSecurityEnabled(item('enrolled', true, 0))).toBe(true)
    expect(payrollSocialSecurityEnabled(item('unenrolled', false, 0))).toBe(false)
  })

  it('partitions monthly employees exactly once and keeps daily payroll separate', () => {
    const rows = [item('a', true, 875), item('EMP00024', false, 0), item('zero-wage', true, 0), item('daily', false, 0, 'daily')]
    const enrolled = monthlyPayrollGroup(rows, true)
    const unenrolled = monthlyPayrollGroup(rows, false)
    expect(enrolled.map(row => row.employee_id)).toEqual(['a', 'zero-wage'])
    expect(unenrolled.map(row => row.employee_id)).toEqual(['EMP00024'])
    expect(new Set([...enrolled, ...unenrolled].map(row => row.employee_id)).size).toBe(3)
    expect(rows).toHaveLength(4)
  })

  it('keeps legacy history grouped by recorded amounts independently of today employee settings', () => {
    const legacy = [item('legacy-enrolled', null, 750), item('legacy-zero', null, 0)]
    expect(monthlyPayrollGroup(legacy, true).map(row => row.employee_id)).toEqual(['legacy-enrolled'])
    expect(monthlyPayrollGroup(legacy, false).map(row => row.employee_id)).toEqual(['legacy-zero'])
    expect(legacy.every(row => row.social_security_enabled === null)).toBe(true)
  })

  it('does not alter saved amounts or enrollment while selecting/exporting groups', () => {
    const saved = Object.freeze(item('a', true, 875))
    expect(monthlyPayrollGroup([saved], true)[0]).toBe(saved)
    expect(monthlyPayrollGroup([saved], false)).toEqual([])
    expect(saved.social_security).toBe(875)
  })

  it('adds EMP00024 to an existing draft without dropping or duplicating the other group', () => {
    const saved = [item('existing', true, 875)]
    const employees = [
      { id: 'existing', contract_type: 'permanent' },
      { id: 'EMP00024', contract_type: 'permanent' },
      { id: 'EMP00024', contract_type: 'permanent' },
      { id: 'daily', contract_type: 'daily' },
    ] as HREmployee[]
    const merged = appendMissingMonthlyEmployees(saved, employees, employee => item(employee.id, false, 0))
    expect(merged.map(row => row.employee_id)).toEqual(['existing', 'EMP00024'])
    expect(merged[0]).toBe(saved[0])
    expect(saved).toHaveLength(1)
    expect(monthlyPayrollGroup(merged, false)[0].employee_id).toBe('EMP00024')
  })
})
