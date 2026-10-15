import { describe, expect, it } from 'vitest'
import { canCorrectMarketplaceItem, preserveUnflaggedMarketplaceFields } from './marketplaceCorrections'

describe('Marketplace corrections', () => {
  it('enables only flagged fields and resolves the layer/line-art aliases', () => {
    expect(canCorrectMarketplaceItem('font', { font: true })).toBe(true)
    expect(canCorrectMarketplaceItem('line_1', { font: true })).toBe(false)
    expect(canCorrectMarketplaceItem('product_type', { layer: true })).toBe(true)
    expect(canCorrectMarketplaceItem('line_pattern', { line_art: true })).toBe(true)
    expect(canCorrectMarketplaceItem('quantity', { quantity: true })).toBe(false)
    expect(canCorrectMarketplaceItem('product_id', { product_name: true })).toBe(false)
    expect(canCorrectMarketplaceItem('font', null)).toBe(false)
  })

  it('preserves unflagged fields and stored nulls without applying unrelated defaults', () => {
    const original = { id: 'i1', font: 'F01', line_1: 'Alice', product_type: null as string | null, quantity: 3 }
    const proposed = { id: 'other', font: 'F02', line_1: 'wrong edit', product_type: 'ชั้น1', quantity: 1 }
    expect(preserveUnflaggedMarketplaceFields(original, proposed, { font: true })).toEqual({ ...original, font: 'F02' })
    expect(original.font).toBe('F01')
  })
})
