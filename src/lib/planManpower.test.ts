import { describe, expect, it } from 'vitest'
import { effectiveOperatorCount, effectiveRequiredHeadcount } from './planManpower'

describe('อนุญาตให้หัวหน้าทำงาน', () => {
  it('ปิดสวิตช์แล้วแยกจำนวนหัวหน้าออกจากคนทำงาน', () => {
    expect(effectiveOperatorCount(1, 0, 1, false)).toBe(0)
    expect(effectiveRequiredHeadcount(3, 1, false)).toBe(4)
  })

  it('เปิดสวิตช์แล้วหัวหน้าครอบคลุมโควตาคนทำงานด้วย', () => {
    expect(effectiveOperatorCount(1, 0, 1, true)).toBe(1)
    expect(effectiveRequiredHeadcount(3, 1, true)).toBe(3)
  })

  it('ไม่มีความต้องการหัวหน้าแล้วไม่เปลี่ยน Logic', () => {
    expect(effectiveOperatorCount(0, 2, 1, true)).toBe(2)
    expect(effectiveRequiredHeadcount(3, 0, true)).toBe(3)
  })
})
