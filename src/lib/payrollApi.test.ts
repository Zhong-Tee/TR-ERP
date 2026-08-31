import { describe, expect, it } from 'vitest'
import { calculateCappedSavings, calculateDailyWageSummary, calculateEmployeeEwf, calculateEwf, calculateOvertimePay, calculateSocialSecurity, type DailyWageDetail } from './payrollApi'

describe('calculateOvertimePay', () => {
  it('calculates daily employee OT at 1.5x on workdays and 3x on holidays', () => {
    expect(calculateOvertimePay({
      salary: 400,
      contractType: 'daily',
      normalHours: 2,
      holidayHours: 1,
    })).toEqual({ normalHours: 2, holidayHours: 1, overtimePay: 300 })
  })

  it('converts monthly salary to a daily and hourly wage before applying OT rates', () => {
    expect(calculateOvertimePay({
      salary: 15000,
      contractType: 'permanent',
      normalHours: 2,
      holidayHours: 1,
    })).toEqual({ normalHours: 2, holidayHours: 1, overtimePay: 375 })
  })
})

describe('calculateDailyWageSummary', () => {
  it('pays worked days, half days and company holidays but not full-day leave', () => {
    const makeDetail = (status: DailyWageDetail['status'], payableDay: number): DailyWageDetail => ({
      workDate: '2026-08-01', status, payableDay, dailyRate: 400, amount: 400 * payableDay, note: '',
    })
    const result = calculateDailyWageSummary(400, [
      makeDetail('worked_full', 1),
      makeDetail('worked_half', 0.5),
      makeDetail('paid_holiday', 1),
      makeDetail('unpaid_leave', 0),
      makeDetail('unpaid_leave', 0.5),
      makeDetail('unresolved', 0),
    ])

    expect(result).toMatchObject({
      fullDays: 1,
      halfDays: 2,
      paidHolidayDays: 1,
      unpaidLeaveDays: 1.5,
      payableDays: 3,
      unresolvedDays: 1,
      regularPay: 1200,
    })
  })
})

describe('calculateSocialSecurity', () => {
  const settings = { contribution_rate: 5, maximum_wage_base: 17500 }

  it('calculates the contribution from the supplied base salary', () => {
    expect(calculateSocialSecurity(15000, settings)).toBe(750)
  })

  it('caps the contribution at the configured maximum wage base', () => {
    expect(calculateSocialSecurity(20000, settings)).toBe(875)
  })
})

describe('calculateEwf', () => {
  it('calculates 0.25% from base salary plus position allowance', () => {
    expect(calculateEwf(17000 + 2000)).toBe(47.5)
  })

  it('rounds the result to two decimal places', () => {
    expect(calculateEwf(16667)).toBe(41.67)
  })
})

describe('calculateEmployeeEwf', () => {
  it('does not deduct EWF from EMP00001', () => {
    expect(calculateEmployeeEwf('EMP00001', 150000, true)).toBe(0)
  })

  it('does not deduct EWF when the company setting is disabled', () => {
    expect(calculateEmployeeEwf('EMP00002', 100000, false)).toBe(0)
  })

  it('calculates EWF for other employees when enabled', () => {
    expect(calculateEmployeeEwf('EMP00002', 100000, true)).toBe(250)
  })

  it('calculates daily employee EWF from the regular wage actually payable', () => {
    expect(calculateEmployeeEwf('EMP00021', 10500)).toBe(26.25)
  })
})

describe('calculateCappedSavings', () => {
  it('uses the employee monthly amount when no maximum is set', () => {
    expect(calculateCappedSavings({
      monthlySavings: 14500,
      openingBalance: 0,
      priorSavings: 0,
      maximumBalance: null,
    })).toBe(14500)
  })

  it('limits the current deduction to the remaining maximum', () => {
    expect(calculateCappedSavings({
      monthlySavings: 1000,
      openingBalance: 14500,
      priorSavings: 0,
      maximumBalance: 15000,
    })).toBe(500)
  })

  it('stops deducting after accumulated savings reach the maximum', () => {
    expect(calculateCappedSavings({
      monthlySavings: 500,
      openingBalance: 14000,
      priorSavings: 1000,
      maximumBalance: 15000,
    })).toBe(0)
  })
})
