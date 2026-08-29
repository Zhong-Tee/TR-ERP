import { describe, expect, it } from 'vitest'
import { calculateCappedSavings, calculateEwf } from './payrollApi'

describe('calculateEwf', () => {
  it('calculates 0.25% from base salary plus position allowance', () => {
    expect(calculateEwf(17000 + 2000)).toBe(47.5)
  })

  it('rounds the result to two decimal places', () => {
    expect(calculateEwf(16667)).toBe(41.67)
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
