import { describe, expect, it } from 'vitest'
import { calculateChargeableItemsTotal, isCondoPriceDetailRow } from './orderItemPricing'

describe('order item pricing', () => {
  it('charges a condo stamp once and excludes its detail floors', () => {
    const items = [
      { product_name: 'ตรายางคอนโด CDAE', product_type: 'ชั้น1', quantity: 1, unit_price: 290 },
      ...[2, 3, 4, 5].map((floor) => ({
        product_name: 'ตรายางคอนโด CDAE',
        product_type: `ชั้น${floor}`,
        quantity: 1,
        unit_price: 290,
        is_detail_row: true,
        parent_item_id: 'floor-1',
      })),
    ]

    expect(calculateChargeableItemsTotal(items)).toBe(290)
  })

  it('recognizes legacy condo detail rows without structural flags', () => {
    expect(isCondoPriceDetailRow({ product_name: 'ตรายางคอนโด รุ่นเก่า', product_type: 'ชั้น2' })).toBe(true)
    expect(isCondoPriceDetailRow({ product_name: 'ตรายางคอนโด รุ่นเก่า', product_type: 'ชั้น1' })).toBe(false)
  })

  it('still totals normal products by quantity and ignores free items', () => {
    expect(calculateChargeableItemsTotal([
      { quantity: 2, unit_price: 100 },
      { quantity: 1, unit_price: 50, is_free: true },
    ])).toBe(200)
  })
})
