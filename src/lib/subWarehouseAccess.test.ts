import { describe, expect, it } from 'vitest'
import { canManageSubWarehouseStock, canRequestSubWarehouseStock } from './subWarehouseAccess'

describe('sub warehouse stock capabilities', () => {
  it.each(['superadmin', 'admin', 'store'])('%s จัดการสต๊อคได้', (role) => {
    expect(canManageSubWarehouseStock(role, false)).toBe(true)
    expect(canRequestSubWarehouseStock(role, false)).toBe(false)
  })

  it.each(['production', 'qc_staff', 'packing_staff'])('%s ขอเบิกได้แต่เพิ่มลดเองไม่ได้', (role) => {
    expect(canManageSubWarehouseStock(role, false)).toBe(false)
    expect(canRequestSubWarehouseStock(role, false)).toBe(true)
  })

  it('Store สำรองทำงานเหมือน Store ระหว่างได้รับสิทธิ์', () => {
    expect(canManageSubWarehouseStock('production', true)).toBe(true)
    expect(canRequestSubWarehouseStock('production', true)).toBe(false)
  })

  it('role อื่นดูได้อย่างเดียว', () => {
    expect(canManageSubWarehouseStock('account', false)).toBe(false)
    expect(canRequestSubWarehouseStock('account', false)).toBe(false)
  })
})
