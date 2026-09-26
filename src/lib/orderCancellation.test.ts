import { describe, expect, it } from 'vitest'
import { isZeroValueOrder } from './orderCancellation'

describe('isZeroValueOrder', () => {
  it('allows deletion only when the bill total is exactly zero', () => {
    expect(isZeroValueOrder(0)).toBe(true)
    expect(isZeroValueOrder('0')).toBe(true)
    expect(isZeroValueOrder(0.01)).toBe(false)
    expect(isZeroValueOrder(-0.01)).toBe(false)
    expect(isZeroValueOrder(null)).toBe(false)
    expect(isZeroValueOrder(undefined)).toBe(false)
    expect(isZeroValueOrder('invalid')).toBe(false)
  })
})
