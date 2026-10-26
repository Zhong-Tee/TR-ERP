import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import GRStockContext from './GRStockContext'
vi.mock('../../lib/supabase', () => ({ supabase: {} }))

describe('shared desktop and mobile GR stock display', () => {
  it('renders history alongside current main stock in green', () => {
    const html = renderToStaticMarkup(createElement(GRStockContext, { note: 'คงเหลือ 232 / จุดสั่งซื้อ 300', stock: { status: 'loaded', qty: 180 }, unitName: 'ชิ้น' }))
    expect(html).toContain('คงเหลือตอนสั่งซื้อ 232 / จุดสั่งซื้อ 300')
    expect(html).toContain('คงเหลือปัจจุบัน: 180 ชิ้น')
    expect(html).toContain('text-green-600')
    expect(html).toContain('ก่อนรับเข้าครั้งนี้')
  })
  it('shows zero as a real current quantity', () => {
    const html = renderToStaticMarkup(createElement(GRStockContext, { stock: { status: 'loaded', qty: 0 }, unitName: 'ขวด' }))
    expect(html).toContain('คงเหลือปัจจุบัน: 0 ขวด')
    expect(html).toContain('คงเหลือตอนสั่งซื้อ: ไม่ได้บันทึก')
  })
  it('shows a load failure rather than a misleading zero', () => {
    const html = renderToStaticMarkup(createElement(GRStockContext, { stock: { status: 'error' }, unitName: 'ชิ้น' }))
    expect(html).toContain('คงเหลือปัจจุบัน: โหลดไม่สำเร็จ')
    expect(html).not.toContain('คงเหลือปัจจุบัน: 0')
  })
})
