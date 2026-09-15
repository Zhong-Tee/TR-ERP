import { describe, expect, it } from 'vitest'
import {
  TUBE_GIFT_PRODUCT_CODE,
  getTubeEligibleQuantity,
  isTubeAutoGiftItem,
  reconcileTubeGiftItems,
} from './orderAutoGifts'

const products = [
  { id: 'tube-a', product_code: '110000252', product_name: 'TUBEW เมนูปูสีขาว', product_category: 'TUBE' },
  { id: 'tube-b', product_code: '110000253', product_name: 'TUBEY เมนูปูสีเหลือง', product_category: ' tube ' },
  { id: 'normal', product_code: 'NORMAL', product_name: 'สินค้าปกติ', product_category: 'ETC' },
  { id: 'gift', product_code: TUBE_GIFT_PRODUCT_CODE, product_name: 'เชือกคละสี 10 เส้น', product_category: 'ETC' },
]

describe('TUBE automatic gift', () => {
  it('adds one free rope row using the total TUBE quantity', () => {
    const result = reconcileTubeGiftItems([
      { product_id: 'tube-a', product_name: 'TUBE A', quantity: 2, unit_price: 100 },
      { product_id: 'normal', product_name: 'Normal', quantity: 4, unit_price: 20 },
      { product_id: 'tube-b', product_name: 'TUBE B', quantity: 3, unit_price: 100 },
    ], products)

    expect(result).toHaveLength(4)
    expect(result.filter((item) => isTubeAutoGiftItem(item, products))).toEqual([
      expect.objectContaining({
        product_id: 'gift',
        product_name: 'เชือกคละสี 10 เส้น',
        quantity: 5,
        unit_price: 0,
        is_free: true,
      }),
    ])
  })

  it('updates the existing gift quantity and consolidates duplicate gift rows', () => {
    const result = reconcileTubeGiftItems([
      { product_id: 'tube-a', quantity: 4 },
      { product_id: 'gift', product_name: 'เชือกคละสี 10 เส้น', quantity: 1, unit_price: 0, is_free: true },
      { product_id: 'gift', product_name: 'เชือกคละสี 10 เส้น', quantity: 2, unit_price: 0, is_free: true },
    ], products)

    expect(result).toHaveLength(2)
    expect(result[1]).toEqual(expect.objectContaining({ quantity: 4, unit_price: 0, is_free: true }))
  })

  it('removes the automatic gift when no paid TUBE item remains', () => {
    const result = reconcileTubeGiftItems([
      { product_id: 'normal', quantity: 1 },
      { product_id: 'gift', product_name: 'เชือกคละสี 10 เส้น', quantity: 1, unit_price: 0, is_free: true },
    ], products)

    expect(result).toEqual([{ product_id: 'normal', quantity: 1 }])
  })

  it('does not count free or detail TUBE rows toward the gift ratio', () => {
    const items = [
      { product_id: 'tube-a', quantity: 2 },
      { product_id: 'tube-a', quantity: 5, is_free: true },
      { product_id: 'tube-b', quantity: 3, is_detail_row: true },
    ]

    expect(getTubeEligibleQuantity(items, products)).toBe(2)
  })

  it('returns the same array when the bill is already synchronized', () => {
    const items = [
      { product_id: 'tube-a', quantity: 2 },
      { product_id: 'gift', product_name: 'เชือกคละสี 10 เส้น', quantity: 2, unit_price: 0, is_free: true },
    ]
    const first = reconcileTubeGiftItems(items, products)
    const second = reconcileTubeGiftItems(first, products)

    expect(second).toBe(first)
  })

  it('does not create an invalid gift row when the configured product is unavailable', () => {
    const result = reconcileTubeGiftItems(
      [{ product_id: 'tube-a', quantity: 1 }],
      products.filter((product) => product.id !== 'gift'),
    )

    expect(result).toEqual([{ product_id: 'tube-a', quantity: 1 }])
  })
})
