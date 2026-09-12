import { describe, expect, it } from 'vitest'
import { findWyProduct, normalizeWyProductCode } from './wyProductMatcher'

const products = [
  { id: 'wys01g', product_code: '220000020', product_name: 'WYS01G' },
  { id: 'wys07', product_code: '220000062', product_name: 'WYS07' },
  { id: 'pvcs28', product_code: '110000428', product_name: 'PVCS28' },
]

describe('WY product matching', () => {
  it('normalizes the WY prefix and a single-digit WYS model number', () => {
    expect(normalizeWyProductCode("'WY-WYS1G")).toBe('WYS01G')
    expect(normalizeWyProductCode('WY-WYS7')).toBe('WYS07')
  })

  it('matches the product codes from the supplied WY export', () => {
    expect(findWyProduct(products, 'WY-WYS1G', 'สินค้า A')?.id).toBe('wys01g')
    expect(findWyProduct(products, 'WY-WYS7', 'สินค้า B')?.id).toBe('wys07')
  })

  it('does not choose another or partially matching product', () => {
    expect(findWyProduct(products, 'WY-NOT-IN-MASTER', 'PVC')).toBeNull()
    expect(findWyProduct(products, 'WY-NOT-IN-MASTER', '')).toBeNull()
  })

  it('rejects an ambiguous normalized match', () => {
    const ambiguous = [
      ...products,
      { id: 'duplicate', product_code: 'WYS01G', product_name: 'Duplicate WYS01G' },
    ]
    expect(findWyProduct(ambiguous, 'WY-WYS1G', '')).toBeNull()
  })
})
