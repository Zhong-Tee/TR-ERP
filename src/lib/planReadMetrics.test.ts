import { describe, expect, it } from 'vitest'
import { planHistoryEventAffects, planMetricsEventAffects, planQuantityMaps, planWorkOrderIdsKey } from './planReadMetrics'

describe('plan summary dependencies', () => {
  it('uses the same key for track/status/order changes that do not change WO membership', () => {
    expect(planWorkOrderIdsKey([{ work_order_id: 'b' }, { work_order_id: 'a' }, { work_order_id: 'b' }, {}]))
      .toBe(planWorkOrderIdsKey([{ work_order_id: 'a' }, { work_order_id: 'b' }]))
  })
  it('recomputes department settings without changing category quantities or fetching again', () => {
    const metrics = { wo: { bill_count: 4, category_qty: { A: 2, B: 3 } } }
    expect(planQuantityMaps(metrics, { CUT: ['A'], LASER: ['A', 'B'] })).toEqual({
      bills: { wo: 4 }, categories: { wo: { A: 2, B: 3 } }, quantities: { wo: { CUT: 2, LASER: 5 } },
    })
    expect(planQuantityMaps(metrics, {})).toEqual({ bills: { wo: 4 }, categories: {}, quantities: {} })
  })
  it('preserves duplicate configured category entries and zero categories', () => {
    expect(planQuantityMaps({ wo: { bill_count: 0, category_qty: { A: 2 } } }, { CUT: ['A', 'A', 'missing'] }).quantities)
      .toEqual({ wo: { CUT: 4 } })
  })
  it('ignores packing metadata changes but refreshes order moves and status changes', () => {
    const old = { id: 'bill', work_order_id: 'wo', status: 'ใบสั่งงาน', packing_meta: {} }
    expect(planMetricsEventAffects('or_orders', { eventType: 'UPDATE', old, new: { ...old, packing_meta: { tag: 1 } } }, ['wo'])).toBe(false)
    expect(planMetricsEventAffects('or_orders', { eventType: 'UPDATE', old, new: { ...old, status: 'ยกเลิก' } }, ['wo'])).toBe(true)
    expect(planMetricsEventAffects('or_orders', { eventType: 'UPDATE', old, new: { ...old, work_order_id: 'elsewhere' } }, ['wo'])).toBe(true)
  })
  it('refreshes conservatively for incomplete old rows and item quantity changes', () => {
    expect(planMetricsEventAffects('or_orders', { eventType: 'UPDATE', old: { id: 'bill' }, new: { id: 'bill', work_order_id: 'wo' } }, ['wo'])).toBe(true)
    const old = { id: 'item', order_id: 'bill', product_id: 'p', quantity: 2 }
    expect(planMetricsEventAffects('or_order_items', { eventType: 'UPDATE', old, new: { ...old, quantity: 3 } }, ['wo'])).toBe(true)
    expect(planMetricsEventAffects('or_order_items', { eventType: 'UPDATE', old, new: { ...old, packing_status: 'scanned' } }, ['wo'])).toBe(false)
  })
  it('ignores unrelated orders and refreshes category/visibility changes', () => {
    expect(planMetricsEventAffects('or_orders', { eventType: 'INSERT', old: {}, new: { work_order_id: 'other' } }, ['wo'])).toBe(false)
    const old = { id: 'p', product_category: 'A', is_active: true }
    expect(planMetricsEventAffects('pr_products', { eventType: 'UPDATE', old, new: { ...old, product_category: 'B' } }, ['wo'])).toBe(true)
    expect(planMetricsEventAffects('pr_products', { eventType: 'UPDATE', old, new: { ...old, is_active: false } }, ['wo'])).toBe(true)
  })
  it('does not reload cancelled/released history on a parcel metadata update', () => {
    const old = { id: 'o', work_order_id: 'wo', status: 'จัดส่งแล้ว', bill_no: 'B', channel_order_no: 'C',
      customer_name: 'name', plan_released_from_work_order_id: null, plan_released_from_work_order: null }
    for (const kind of ['cancelled', 'released'] as const) {
      expect(planHistoryEventAffects(kind, 'or_orders', { eventType: 'UPDATE', old, new: { ...old, packing_meta: { tag: 1 } } })).toBe(false)
      expect(planHistoryEventAffects(kind, 'or_orders', { eventType: 'UPDATE', old, new: { ...old, status: 'ยกเลิก' } })).toBe(true)
    }
    expect(planHistoryEventAffects('cancelled', 'or_order_items', { eventType: 'UPDATE', old: { id: 'i' }, new: { id: 'i' } })).toBe(true)
  })
})
