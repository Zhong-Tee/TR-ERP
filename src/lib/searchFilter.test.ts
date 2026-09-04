import { describe, expect, it } from 'vitest'
import { buildWhitespaceTolerantTrackingPattern } from './searchFilter'

describe('buildWhitespaceTolerantTrackingPattern', () => {
  it('ignores whitespace in a tracking-number search', () => {
    const expected = '%T%H%1%2%3%4%5%6%7%8%9%T%H%'
    expect(buildWhitespaceTolerantTrackingPattern('TH123456789TH')).toBe(expected)
    expect(buildWhitespaceTolerantTrackingPattern('TH 123 456 789 TH')).toBe(expected)
  })

  it('does not broaden ordinary short searches', () => {
    expect(buildWhitespaceTolerantTrackingPattern('TEE')).toBeNull()
    expect(buildWhitespaceTolerantTrackingPattern('ลูกค้า ABC123')).toBeNull()
  })
})
