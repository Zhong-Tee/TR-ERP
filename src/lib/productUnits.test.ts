import { describe, expect, it } from 'vitest'
import { formatProductQuantity, normalizeProductUnitName, stockQuantityFromDocument } from './productUnits'

describe('product inventory units', () => {
  it('uses the product transaction unit with a safe default', () => {
    expect(normalizeProductUnitName(' คู่ ')).toBe('คู่')
    expect(normalizeProductUnitName(null)).toBe('ชิ้น')
  })

  it('does not multiply document quantity for stock movement', () => {
    expect(stockQuantityFromDocument(2)).toBe(2)
    expect(stockQuantityFromDocument('2')).toBe(2)
  })

  it('formats quantity together with its unit', () => {
    expect(formatProductQuantity(497, 'คู่')).toContain('497 คู่')
  })
})
