import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ProductCountCard from './ProductCountCard'
import type { InventoryAuditItem } from '../../types'

vi.mock('../../lib/qcApi', () => ({ getPublicUrl: () => '' }))
const item: InventoryAuditItem = {
  id: 'a', audit_id: 'audit', product_id: 'rm', created_at: '', count_mode: 'separate',
  system_qty: 437, system_safety_stock: 29, system_reserved: 13, counted_qty: 0, variance: 0,
  location_snapshot: [{ key: 'storage:a', label_type: 'storage', location_id: 'a', code: 'A', name: 'ชั้นหนึ่ง', qty: 437 }],
  sub_warehouse_snapshot: [
    { sub_warehouse_id: 'sub-a', name: 'คลังผลิต', qty: 1823 },
    { sub_warehouse_id: 'sub-b', name: 'คลังแพ็ก', qty: 2941 },
    { sub_warehouse_id: 'sub-c', name: 'คลังสำรอง', qty: 0 },
  ],
}
const render = (values = item, showSystemQty = false) => renderToStaticMarkup(createElement(ProductCountCard, { item: values, showSystemQty, onSave: async () => {}, onCancel: () => {}, saving: false }))

describe('Audit count form', () => {
  it('keeps location names visible while hiding all expected quantities in blind count', () => {
    const html = render()
    expect(html).toContain('ชั้นหนึ่ง')
    expect(html).toContain('คลังผลิต')
    expect(html).toContain('คลังแพ็ก')
    expect(html).not.toContain('1,823')
    expect(html).not.toContain('2,941')
    expect(html).not.toContain('437')
    expect(html).not.toContain('จอง:')
    expect(html).toContain('สต๊อคปกติที่นับได้ (ไม่รวม Safety)')
    expect(html).toContain('Safety Stock ที่นับได้')
    expect(html.match(/type="number"/g)).toHaveLength(2)
  })
  it('shows normal, safety, total and reservation context when enabled', () => {
    const html = render(item, true)
    expect(html).toContain('437')
    expect(html).toContain('Safety: 29')
    expect(html).toContain('รวม: 466')
    expect(html).toContain('จอง: 13')
    expect(html).toContain('1,823')
    expect(html).toContain('2,941')
    expect(html).toContain('ไม่รวมในยอดรวมและจำนวนที่ต้องนับ')
    expect(html).not.toContain('5,230') // Sub-warehouse balances must not inflate main stock totals.
    expect(html.match(/type="number"/g)).toHaveLength(2)
  })
  it('distinguishes an empty snapshot from a missing snapshot', () => {
    expect(render({ ...item, sub_warehouse_snapshot: [] }, true)).toContain('ไม่มีรายการสินค้านี้ในคลังย่อย')
    expect(render({ ...item, sub_warehouse_snapshot: null }, true)).toContain('ไม่มีข้อมูลยอดคลังย่อย')
  })
  it('labels historical reconstructions for existing audits', () => {
    expect(render({ ...item, sub_warehouse_snapshot_reconstructed: true }, true)).toContain('ชื่อคลังใช้ชื่อปัจจุบัน')
  })
  it('allows adding a newly discovered safety bucket, but ST has a single physical count', () => {
    expect(render({ ...item, system_safety_stock: 0 })).toContain('พบ Safety จริง')
    const st = render({ ...item, product_type: 'ST', system_safety_stock: null })
    expect(st).toContain('จำนวนจริงรวมที่นับได้ (ST)')
    expect(st.match(/type="number"/g)).toHaveLength(1)
    expect(st).not.toContain('พบ Safety จริง')
  })
})
