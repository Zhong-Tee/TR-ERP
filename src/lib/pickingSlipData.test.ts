import { describe, expect, it } from 'vitest'
import { filterPickingDepartment, pickingDestination, type PickingSlipData } from './pickingSlipData'

describe('picking slip routing', () => {
  const excluded = new Set(['UV', 'CTT'])
  it('prioritizes an active sub-warehouse over main picking and excluded categories', () => {
    expect(pickingDestination('LASER', ['คลังย่อย'], excluded)).toBe('sub')
    expect(pickingDestination('UV', ['คลังย่อย'], excluded)).toBe('sub')
  })
  it('matches WMS category normalization and does not exclude new categories by substring', () => {
    expect(pickingDestination(' uv ', [], excluded)).toBe('skip')
    expect(pickingDestination('', [], excluded)).toBe('skip')
    expect(pickingDestination('UV SPECIAL', [], excluded)).toBe('main')
    expect(pickingDestination('NEW', [], excluded)).toBe('main')
  })
})
const data: PickingSlipData = { workOrderName: 'TEST', departments: ['LASER', 'STAMP'], spareDept: 'STAMP',
  mainItems: [{ woName: 'TEST', location: 'A1', code: '001', name: 'สินค้า "พิเศษ"', finalQty: 3, dept: 'LASER' }],
  spareItems: [{ label: 'R-1', qty: 7 }],
  nonPickItems: [],
  subItems: [{ woName: 'TEST', location: 'B1', code: '002', name: 'สีไม้', finalQty: 5, dept: 'LASER', warehouse: 'ย่อย A / ย่อย B' }] }
it('filters all three sections consistently without duplicating quantities for multiple warehouses', () => {
  const laser = filterPickingDepartment(data, 'LASER')
  expect(laser.mainItems).toHaveLength(1)
  expect(laser.subItems).toHaveLength(1)
  expect(laser.subItems[0].finalQty).toBe(5)
  expect(laser.spareItems).toHaveLength(0)
  expect(filterPickingDepartment(data, 'STAMP').spareItems[0].qty).toBe(7)
  expect(filterPickingDepartment(data, null)).toBe(data)
})
