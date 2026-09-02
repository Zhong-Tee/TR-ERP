import { describe, expect, it } from 'vitest'
import { identifyCondoStampItems, isCondoStampItem } from './condoStamp'
import { sortOrderItemsForExport } from './orderItemExportSort'

describe('condo stamp item detection', () => {
  it('detects every row in a condo group from detail-row structure', () => {
    const items = [
      { id: 'main', product_id: 'cdab1', product_name: 'สินค้า CDAB1', product_type: 'ชั้น1' },
      { id: 'detail-2', product_id: 'cdab1', product_name: 'สินค้า CDAB1', product_type: 'ชั้น2', is_detail_row: true, parent_item_id: 'main' },
      { id: 'other', product_id: 'other', product_name: 'สินค้าทั่วไป', product_type: 'ชั้น1' },
    ]

    const identity = identifyCondoStampItems(items)

    expect(isCondoStampItem(items[0], identity)).toBe(true)
    expect(isCondoStampItem(items[1], identity)).toBe(true)
    expect(isCondoStampItem(items[2], identity)).toBe(false)
  })

  it('supports category metadata and legacy condo product names', () => {
    const items = [
      { id: 'category', product_id: 'category-product', product_name: 'CDAB1' },
      { id: 'legacy', product_id: 'legacy-product', product_name: 'ตรายางคอนโด รุ่นเก่า' },
    ]
    const identity = identifyCondoStampItems(items, { 'category-product': 'CONDO STAMP 5FL' })

    expect(isCondoStampItem(items[0], identity)).toBe(true)
    expect(isCondoStampItem(items[1], identity)).toBe(true)
  })

  it('sorts newly named condo rows by floor before non-condo rows', () => {
    const items = [
      { id: 'other', product_id: 'other', product_name: 'สินค้าทั่วไป', product_type: 'ชั้น1' },
      { id: 'floor-2', product_id: 'cdab1', product_name: 'ตรายางคอนโด CDAB1', product_type: 'ชั้น2', is_detail_row: true, parent_item_id: 'floor-1' },
      { id: 'floor-1', product_id: 'cdab1', product_name: 'ตรายางคอนโด CDAB1', product_type: 'ชั้น1' },
    ]

    expect(sortOrderItemsForExport(items).map((item) => item.id)).toEqual(['floor-1', 'floor-2', 'other'])
  })
})
