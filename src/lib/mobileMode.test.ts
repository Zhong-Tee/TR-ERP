import { describe, expect, it } from 'vitest'
import type { User } from '../types'
import { getMobileAccess, getSelectableMobileModes, modeAllowsPath } from './mobileMode'

function user(role: User['role'], mobileAccess: string[]): User {
  return {
    id: 'user-1',
    email: 'user@example.com',
    role,
    mobile_access: mobileAccess,
  }
}

describe('mobile mode permissions', () => {
  it('Sales requires an explicit grant and an existing QT/PC business role', () => {
    expect(getSelectableMobileModes(user('sales-tr', []))).not.toContain('sales_mb')
    for (const role of ['sales-tr', 'sales-pump', 'superadmin'] as const) {
      expect(getSelectableMobileModes(user(role, ['sales_mb']))).toContain('sales_mb')
    }
    expect(getSelectableMobileModes(user('picker', ['sales_mb']))).not.toContain('sales_mb')
  })

  it('Sales mode never grants access to desktop orders or similarly prefixed URLs', () => {
    expect(modeAllowsPath('sales_mb', '/sales-mobile')).toBe(true)
    for (const path of ['/orders', '/orders/new', '/sales-mobile-admin', '/sales-mobile/orders']) {
      expect(modeAllowsPath('sales_mb', path)).toBe(false)
    }
  })
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
