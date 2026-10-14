import { describe, expect, it } from 'vitest'
import { dedupeWmsNotificationsForDisplay, enrichWmsNotificationsWithOrderDetails, resolveWmsNotificationProduct } from './wmsNotificationEnrichment'
import { wmsItemNotificationPayload } from './wmsItemNotification'
import type { SupabaseClient } from '@supabase/supabase-js'

const rows = [
  { id: 'bubble', order_id: 'REQ-1', product_code: '990000046', product_name: 'Bubble 32.5x100m ม้วน', location: null, status: 'correct' },
  { id: 'label', order_id: 'REQ-1', product_code: '990000055', product_name: 'ใบปะหน้า แบบพับ 500แผ่น', location: 'MOV-E-S02-B07', status: 'out_of_stock' },
]
describe('product-specific WMS notifications', () => {
  it('sends the exact item ID and product snapshot from the pressed card', () => {
    expect(wmsItemNotificationPayload(rows[1], 'picker', 'สินค้าหมด (X)')).toMatchObject({
      wms_order_id: 'label', product_code: '990000055', product_name: rows[1].product_name, location: 'MOV-E-S02-B07', order_id: 'REQ-1',
    })
  })
  it('uses the linked second item instead of the first product in the job', () => {
    expect(resolveWmsNotificationProduct({ wms_order_id: 'label' }, rows)).toEqual({ product_name: rows[1].product_name, location: 'MOV-E-S02-B07' })
  })
  it('preserves the snapshot after the underlying WMS row is changed or removed', () => {
    const payload = wmsItemNotificationPayload(rows[1], 'picker', 'หัวข้ออื่น')
    expect(resolveWmsNotificationProduct(payload, [])).toEqual({ product_name: rows[1].product_name, location: 'MOV-E-S02-B07' })
  })
  it('does not guess historical products from their current out-of-stock status', () => {
    expect(resolveWmsNotificationProduct({ type: 'สินค้าหมด (X)' }, rows).product_name).toContain('ไม่ได้ระบุ')
    expect(resolveWmsNotificationProduct({ wms_order_id: 'removed' }, rows).product_name).toContain('ไม่พบรายการ')
    expect(resolveWmsNotificationProduct({}, [rows[1]]).product_name).toBe(rows[1].product_name)
  })
  it('keeps distinct item alerts while still deduplicating whole-job cancellations', () => {
    const alerts = [{ type: 'สินค้าหมด (X)', order_id: 'REQ-1' }, { type: 'สินค้าหมด (X)', order_id: 'REQ-1' }]
    expect(dedupeWmsNotificationsForDisplay(alerts)).toHaveLength(2)
    expect(dedupeWmsNotificationsForDisplay(alerts.map(row => ({ ...row, type: 'ยกเลิกบิล' })))).toHaveLength(1)
  })
  it('enriches the table and picker history with the reported product', async () => {
    // Exercise the complete shared enrichment path, not only the resolver.
    const client = { from: (table: string) => ({ select: () => ({ in: () => ({
      data: table === 'wms_orders' ? rows : [],
      order: async () => ({ data: [] }),
    }) }) }) } as unknown as SupabaseClient
    const [result] = await enrichWmsNotificationsWithOrderDetails(client, [{ type: 'สินค้าหมด (X)', order_id: 'REQ-1', wms_order_id: 'label' }])
    expect(result.product_name).toBe('ใบปะหน้า แบบพับ 500แผ่น')
    expect(result.location).toBe('MOV-E-S02-B07')
  })
})
