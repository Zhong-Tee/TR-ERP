import { describe, expect, it } from 'vitest'
import { isPhysicalOrderItem } from './condoStamp'

describe('physical condo stock quantities', () => {
  it.each([2, 3, 5])('counts a %i-floor stamp once, including legacy rows without detail flags', (floors) => {
    const rows = Array.from({ length: floors }, (_, index) => ({
      product_name: `ตรายางคอนโด CDAA1 ${floors}ชั้น`,
      product_type: `ชั้น${index + 1}`,
      quantity: 1,
    }))
    expect(rows.filter(isPhysicalOrderItem).reduce((sum, row) => sum + row.quantity, 0)).toBe(1)
  })

  it('preserves multiple sets and quantities greater than one instead of dividing by five', () => {
    const rows = [2, 3].flatMap(quantity => Array.from({ length: 5 }, (_, index) => ({
      product_name: 'renamed product', product_category: 'CONDO STAMP 5FL',
      product_type: `ชั้น ${index + 1}`, quantity,
    })))
    expect(rows.filter(isPhysicalOrderItem).reduce((sum, row) => sum + row.quantity, 0)).toBe(5)
  })

  it('honors explicit detail links and keeps ordinary/free physical products', () => {
    expect(isPhysicalOrderItem({ is_detail_row: true })).toBe(false)
    expect(isPhysicalOrderItem({ parent_item_id: 'main' })).toBe(false)
    expect(isPhysicalOrderItem({ product_name: 'ordinary product', product_type: 'ชั้น2' })).toBe(true)
    expect(isPhysicalOrderItem({ product_name: 'ตรายางคอนโด CDAA1', product_type: 'ชั้น1' })).toBe(true)
  })
})
