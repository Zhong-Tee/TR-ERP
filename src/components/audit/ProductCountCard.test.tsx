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
}
const render = (values = item, showSystemQty = false) => renderToStaticMarkup(createElement(ProductCountCard, { item: values, showSystemQty, onSave: async () => {}, onCancel: () => {}, saving: false }))

describe('Audit count form', () => {
  it('keeps location names visible while hiding all expected quantities in blind count', () => {
    const html = render()
    expect(html).toContain('ชั้นหนึ่ง')
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
  })
  it('allows adding a newly discovered safety bucket, but ST has a single physical count', () => {
    expect(render({ ...item, system_safety_stock: 0 })).toContain('พบ Safety จริง')
    const st = render({ ...item, product_type: 'ST', system_safety_stock: null })
    expect(st).toContain('จำนวนจริงรวมที่นับได้ (ST)')
    expect(st.match(/type="number"/g)).toHaveLength(1)
    expect(st).not.toContain('พบ Safety จริง')
  })
})
