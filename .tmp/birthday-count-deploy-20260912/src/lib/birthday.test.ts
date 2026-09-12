import { describe, expect, it } from 'vitest'
import { isBirthdayMonth } from './birthday'

describe('isBirthdayMonth', () => {
  it('แสดงเดือนเกิดเมื่อเดือนตรงกันตามเวลาไทย', () => {
    const bangkokSeptember = new Date('2026-08-31T17:01:00.000Z')
    expect(isBirthdayMonth('1990-09-15', bangkokSeptember)).toBe(true)
    expect(isBirthdayMonth('1990-08-15', bangkokSeptember)).toBe(false)
  })

  it('ไม่แสดงเมื่อไม่มีหรือรูปแบบวันเกิดไม่ถูกต้อง', () => {
    expect(isBirthdayMonth(null)).toBe(false)
    expect(isBirthdayMonth('15/09/1990')).toBe(false)
    expect(isBirthdayMonth('1990-13-15')).toBe(false)
  })
})
