import { describe, expect, it } from 'vitest'
import { identifyCondoStampItems, isCondoStampItem } from './condoStamp'
import { sortOrderItemsForBillDisplay, sortOrderItemsForExport } from './orderItemExportSort'
import { flatBillUnitUid } from './productionUnits'

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

  it('keeps condo text aligned with flattened bill sequence from floor 1 through 5', () => {
    const items = [
      { id: 'floor-4', product_id: 'cdab1', product_name: 'ตรายางคอนโด CDAB1', product_type: 'ชั้น4', line_1: 'Admit ฉุกเฉิน', is_detail_row: true, parent_item_id: 'floor-1' },
      { id: 'floor-2', product_id: 'cdab1', product_name: 'ตรายางคอนโด CDAB1', product_type: 'ชั้น2', line_1: 'Thrombectomy', is_detail_row: true, parent_item_id: 'floor-1' },
      { id: 'floor-5', product_id: 'cdab1', product_name: 'ตรายางคอนโด CDAB1', product_type: 'ชั้น5', line_1: 'Browse แล้ว', is_detail_row: true, parent_item_id: 'floor-1' },
      { id: 'floor-1', product_id: 'cdab1', product_name: 'ตรายางคอนโด CDAB1', product_type: 'ชั้น1', line_1: 'Stroke fast track' },
      { id: 'floor-3', product_id: 'cdab1', product_name: 'ตรายางคอนโด CDAB1', product_type: 'ชั้น3', line_1: 'Refer back', is_detail_row: true, parent_item_id: 'floor-1' },
    ]

    const sorted = sortOrderItemsForExport(items)
    const units = sorted.map((item, index) => ({
      uid: flatBillUnitUid('PUMP26090021', index + 1),
      line1: item.line_1,
    }))

    expect(sorted.map((item) => item.product_type)).toEqual(['ชั้น1', 'ชั้น2', 'ชั้น3', 'ชั้น4', 'ชั้น5'])
    expect(units[1]).toEqual({ uid: 'PUMP26090021-2', line1: 'Thrombectomy' })
  })

  it('groups multiple condo stamps into separate floor 1 through 5 sets for bill display', () => {
    const items = [
      { id: 'pink-1', product_id: 'pink', product_name: 'ตรายางคอนโด CDAB1 แมวชมพู 5ชั้น', product_type: 'ชั้น1', created_at: '2026-09-04T01:00:00Z' },
      { id: 'pink-2', product_id: 'pink', product_name: 'ตรายางคอนโด CDAB1 แมวชมพู 5ชั้น', product_type: 'ชั้น2', parent_item_id: 'pink-1', is_detail_row: true, created_at: '2026-09-04T01:01:00Z' },
      { id: 'pink-3', product_id: 'pink', product_name: 'ตรายางคอนโด CDAB1 แมวชมพู 5ชั้น', product_type: 'ชั้น3', parent_item_id: 'pink-1', is_detail_row: true, created_at: '2026-09-04T01:02:00Z' },
      { id: 'pink-4', product_id: 'pink', product_name: 'ตรายางคอนโด CDAB1 แมวชมพู 5ชั้น', product_type: 'ชั้น4', parent_item_id: 'pink-1', is_detail_row: true, created_at: '2026-09-04T01:03:00Z' },
      { id: 'pink-5', product_id: 'pink', product_name: 'ตรายางคอนโด CDAB1 แมวชมพู 5ชั้น', product_type: 'ชั้น5', parent_item_id: 'pink-1', is_detail_row: true, created_at: '2026-09-04T01:04:00Z' },
      { id: 'blue-1', product_id: 'blue', product_name: 'ตรายางคอนโด CDAB2 นกฮูกฟ้า 5ชั้น', product_type: 'ชั้น1', created_at: '2026-09-04T01:05:00Z' },
      { id: 'blue-2', product_id: 'blue', product_name: 'ตรายางคอนโด CDAB2 นกฮูกฟ้า 5ชั้น', product_type: 'ชั้น2', parent_item_id: 'blue-1', is_detail_row: true, created_at: '2026-09-04T01:06:00Z' },
      { id: 'blue-3', product_id: 'blue', product_name: 'ตรายางคอนโด CDAB2 นกฮูกฟ้า 5ชั้น', product_type: 'ชั้น3', parent_item_id: 'blue-1', is_detail_row: true, created_at: '2026-09-04T01:07:00Z' },
      { id: 'blue-4', product_id: 'blue', product_name: 'ตรายางคอนโด CDAB2 นกฮูกฟ้า 5ชั้น', product_type: 'ชั้น4', parent_item_id: 'blue-1', is_detail_row: true, created_at: '2026-09-04T01:08:00Z' },
      { id: 'blue-5', product_id: 'blue', product_name: 'ตรายางคอนโด CDAB2 นกฮูกฟ้า 5ชั้น', product_type: 'ชั้น5', parent_item_id: 'blue-1', is_detail_row: true, created_at: '2026-09-04T01:09:00Z' },
    ]

    const sorted = sortOrderItemsForBillDisplay(items)

    expect(sorted.map((item) => item.id)).toEqual([
      'pink-1', 'pink-2', 'pink-3', 'pink-4', 'pink-5',
      'blue-1', 'blue-2', 'blue-3', 'blue-4', 'blue-5',
    ])
  })
})
