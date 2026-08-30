import { describe, expect, it } from 'vitest'
import { calculateCappedSavings, calculateEmployeeEwf, calculateEwf } from './payrollApi'

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
