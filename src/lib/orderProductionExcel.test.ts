import { describe, expect, it } from 'vitest'
import type { Order, OrderItem } from '../types'
import { buildProductionDataRowsForOrder, PRODUCTION_EXCEL_HEADERS } from './orderProductionExcel'

describe('production export item notes', () => {
  const order = { bill_no: '(Claim)FBTR-TEST', work_order_name: 'งานเคลม' } as Order

  it('exports a claim item note in the existing หมายเหตุ column', () => {
    const item = {
      item_uid: '(Claim)FBTR-TEST-1',
      product_name: 'สินค้าทดสอบ',
      quantity: 1,
      notes: 'แก้ข้อความบรรทัดแรก',
    } as OrderItem

    const [row] = buildProductionDataRowsForOrder(order, [item], {}, {})
    const notesIndex = PRODUCTION_EXCEL_HEADERS.indexOf('หมายเหตุ')

    expect(notesIndex).toBeGreaterThan(-1)
    expect(row[notesIndex]).toBe('แก้ข้อความบรรทัดแรก')
  })

  it('keeps the note when the item is marked ไม่รับชื่อ', () => {
    const item = {
      item_uid: '(Claim)FBTR-TEST-1',
      product_name: 'สินค้าทดสอบ',
      quantity: 1,
      no_name_line: true,
      notes: 'ใช้แบบเดิม',
    } as OrderItem

    const [row] = buildProductionDataRowsForOrder(order, [item], {}, {})
    const notesIndex = PRODUCTION_EXCEL_HEADERS.indexOf('หมายเหตุ')

    expect(row[notesIndex]).toBe('ไม่รับชื่อ ใช้แบบเดิม')
  })
})
