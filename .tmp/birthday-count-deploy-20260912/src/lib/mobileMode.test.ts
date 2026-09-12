import { describe, expect, it } from 'vitest'
import type { User } from '../types'
import { getMobileAccess, getSelectableMobileModes } from './mobileMode'

function user(role: User['role'], mobileAccess: string[]): User {
  return {
    id: 'user-1',
    email: 'user@example.com',
    role,
    mobile_access: mobileAccess,
  }
}

describe('mobile mode permissions', () => {
  it('ไม่นับ mobile_access ที่ซ้ำกับ role หลักเป็นโหมดเพิ่มเติม', () => {
    const picker = user('picker', ['picker'])

    expect(getMobileAccess(picker)).toEqual([])
    expect(getSelectableMobileModes(picker)).toEqual(['picker'])
  })

  it('ยังคงนับโหมดเพิ่มเติมที่ไม่ซ้ำกับ role หลัก', () => {
    const picker = user('picker', ['picker', 'manager', 'auditor'])

    expect(getMobileAccess(picker)).toEqual(['manager', 'auditor'])
    expect(getSelectableMobileModes(picker)).toEqual(['manager', 'picker', 'auditor'])
  })
})
