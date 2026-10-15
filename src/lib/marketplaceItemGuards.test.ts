import { describe, expect, it } from 'vitest'
import { isMarketplaceReviewLocked, mergeBilledMarketplaceItems, normalizeMarketplaceItem, shouldReviewMarketplaceField } from './marketplaceItemGuards'
import { resolveFieldEnabled, type FieldRuleMaps } from './productFieldRules'
import type { MpOrderItem } from '../types/marketplace'

const rules: FieldRuleMaps = {
  categorySettings: { ETC: { font: false, line_1: false, line_2: false, line_3: false } },
  productOverrides: {},
}
const product = { id: 'etc', product_category: 'ETC' }
const draft = (id: string, product_id: string, line_index: number, variation: string) => ({
  id, product_id, line_index, variation, mp_order_id: 'mp',
} as MpOrderItem)

describe('Marketplace safeguards', () => {
  it('locks only Marketplace bills in the review queue, regardless of channel', () => {
    expect(isMarketplaceReviewLocked({ source_marketplace_order_id: 'mp', status: 'รอตรวจคำสั่งซื้อ' })).toBe(true)
    expect(isMarketplaceReviewLocked({ status: 'รอตรวจคำสั่งซื้อ' })).toBe(false)
    expect(isMarketplaceReviewLocked({ source_marketplace_order_id: 'mp', status: 'ลงข้อมูลผิด' })).toBe(false)
    expect(isMarketplaceReviewLocked({ source_marketplace_order_id: 'mp', status: 'รอลงข้อมูล' })).toBe(false)
  })

  it('clears stale personalization after switching to an ETC product', () => {
    const item = { font: 'F01', line_1: 'Alice', line_2: 'Bob', line_3: 'C', no_name_line: true }
    expect(normalizeMarketplaceItem(item, (key) => resolveFieldEnabled(product, key, rules))).toMatchObject({
      font: null, line_1: null, line_2: null, line_3: null, no_name_line: false,
    })
    expect(item.line_1).toBe('Alice')
  })

  it('honors product overrides and clears names when no-name is selected', () => {
    const enabled = (key: string) => resolveFieldEnabled(product, key, {
      ...rules, productOverrides: { etc: { font: 'required', line_1: true } },
    })
    const next = normalizeMarketplaceItem({ font: 'F01', line_1: 'Alice', no_name_line: true }, enabled)
    expect(next.font).toBe('F01')
    expect(next.line_1).toBeNull()
    expect(next.no_name_line).toBe(true)
    expect(normalizeMarketplaceItem(next, enabled)).toBe(next)
  })

  it('hides unused optional lines but keeps missing required fields reviewable', () => {
    expect(shouldReviewMarketplaceField({ line_1: 'Alice' }, 'line_2')).toBe(false)
    expect(shouldReviewMarketplaceField({ line_1: 'Alice' }, 'line_2', true)).toBe(true)
    expect(shouldReviewMarketplaceField({}, 'line_1')).toBe(true)
    expect(shouldReviewMarketplaceField({ line_1: 'stale', no_name_line: true }, 'line_1', true)).toBe(false)
    expect(shouldReviewMarketplaceField({}, 'font')).toBe(true)
  })

  it('keeps file options attached when bill rows 6 and 7 are reordered', () => {
    const drafts = [draft('ruler', 'r', 5, 'RLE01'), draft('pencil', 'p', 6, 'PCN')]
    const merged = mergeBilledMarketplaceItems([
      { id: 'b-p', product_id: 'p', item_uid: 'SPTR-7' },
      { id: 'b-r', product_id: 'r', item_uid: 'SPTR-6' },
    ], drafts)
    expect(merged.map((item) => item.variation)).toEqual(['PCN', 'RLE01'])
  })

  it('uses persisted source identity even when a product was corrected later', () => {
    const merged = mergeBilledMarketplaceItems([
      { id: 'bill', product_id: 'corrected', source_mp_order_item_id: 'source' },
    ], [draft('source', 'wrong-product', 0, 'original-file-option')])
    expect(merged[0].variation).toBe('original-file-option')
  })

  it('does not guess when multiple legacy rows have the same product', () => {
    const merged = mergeBilledMarketplaceItems([{ id: 'bill', product_id: 'p' }], [
      draft('one', 'p', 0, 'A'), draft('two', 'p', 1, 'B'),
    ])
    expect(merged[0].variation).toBeNull()
  })
})
