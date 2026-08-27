import { describe, expect, it } from 'vitest'
import {
  compareManpowerSkills,
  effectiveOperatorCount,
  effectiveRequiredHeadcount,
  type EmployeeSkill,
} from './planManpower'

const skill = (employee_id: string, proficiency: number, is_primary: boolean): EmployeeSkill => ({
  employee_id,
  department_name: 'เบิก',
  process_name: 'หยิบของ',
  proficiency,
  efficiency_percent: 100,
  qualification_status: 'qualified',
  is_primary,
})

describe('compareManpowerSkills', () => {
  it('prioritizes a primary worker before a higher-scored non-primary worker', () => {
    const rows = [skill('high-score', 5, false), skill('primary', 2, true)].sort(compareManpowerSkills)
    expect(rows.map((row) => row.employee_id)).toEqual(['primary', 'high-score'])
  })
})

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
