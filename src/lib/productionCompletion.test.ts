import { describe, expect, it } from 'vitest'
import { validateProductionActuals } from './productionCompletion'
import type { ProductionActual } from './productionCompletion'

const item = (): ProductionActual => ({
  item_id: 'one', product_code: 'PP', product_name: 'ชุด', planned_qty: 5200,
  actual_qty: 5050, reason_code: 'วัตถุดิบในห่อไม่ครบ', reason: 'ตรวจนับก่อนรับเข้า',
  materials: [{ product_id: 'rm', product_code: 'RM', product_name: 'เส้น', planned_qty: 10400, used_qty: 10100, returned_qty: 100, waste_qty: 0, shortage_qty: 200, reason: 'ห่อขาด' }],
  byproducts: [{ product_id: 'by', product_code: 'BY', product_name: 'สินค้าแยกคืน', planned_qty: 100, qty: 90 }],
})

describe('production receipt validation', () => {
  it('accepts actual receipt and a fully reconciled material allocation', () => {
    expect(validateProductionActuals([item()])).toBeNull()
  })
  it('requires actual quantity to be entered explicitly', () => {
    const x = item(); x.actual_qty = NaN
    expect(validateProductionActuals([x])).toContain('จำนวนผลิตจริง')
  })
  it.each([-1, Infinity, 5201, 1.001])('rejects invalid receipt %s', actual => {
    const x = item(); x.actual_qty = actual
    expect(validateProductionActuals([x])).toContain('จำนวนผลิตจริง')
  })
  it('requires both shortage category and explanation', () => {
    const x = item(); x.reason_code = ''
    expect(validateProductionActuals([x])).toContain('เหตุผล')
    x.reason_code = 'อื่น ๆ'; x.reason = ' '
    expect(validateProductionActuals([x])).toContain('เหตุผล')
  })
  it('checks allocation and requires material variance explanation', () => {
    const x = item(); x.materials[0].returned_qty = 101
    expect(validateProductionActuals([x])).toContain('ต้องเท่ากับ')
    x.materials[0].returned_qty = 100; x.materials[0].reason = ''
    expect(validateProductionActuals([x])).toContain('เหตุผลส่วนต่าง')
  })
  it('allows zero output with explanation to close a failed batch', () => {
    const x = item(); x.actual_qty = 0
    expect(validateProductionActuals([x])).toBeNull()
  })
  it('rejects invalid byproduct quantities and checks all items', () => {
    const x = item(); x.byproducts[0].qty = NaN
    expect(validateProductionActuals([item(), x])).toContain('แยกคืน')
  })
  it('requires at least one product', () => expect(validateProductionActuals([])).not.toBeNull())
})
