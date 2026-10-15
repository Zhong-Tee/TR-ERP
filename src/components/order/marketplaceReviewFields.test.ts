import { describe, expect, it } from 'vitest'
import { getOrderLevelAndItemLevelErrorFields, getReviewableFieldsForItem, getVisibleFieldsForItem } from './OrderReviewList'
import type { Order } from '../../types'

const category = { ETC: { font: false, line_1: false, line_2: false, line_3: false } }
const categories = { p: 'ETC' }

describe('Marketplace review field selection', () => {
  const reviewFields = (overrides: Partial<Order>) => getOrderLevelAndItemLevelErrorFields({
    channel_code: 'SPTR',
    order_items: [{ product_id: 'p', product_name: 'สินค้า', quantity: 1, unit_price: 280 }],
    ...overrides,
  } as Order, {}, {})

  it.each(['SPTR', 'FSPTR', 'LZTR', 'TTTR'])('keeps tracking reviewable while excluding imported order numbers and prices for %s Marketplace bills', (channel_code) => {
    const fields = reviewFields({ channel_code, source_marketplace_order_id: 'mp' })
    expect(fields.orderLevel.map(({ key }) => key)).toEqual(['tracking_number'])
    expect(fields.itemLevel.some(({ key }) => key === 'unit_price')).toBe(false)
    expect(fields.itemLevel.some(({ key }) => key === 'product_name')).toBe(false)
    expect(fields.itemLevel.some(({ key }) => key === 'no_name_line')).toBe(false)
    expect(fields.itemLevel.some(({ key }) => key === 'quantity')).toBe(false)
  })

  it('keeps manually entered extra receipt numbers reviewable, including bills without items', () => {
    const fields = reviewFields({ source_marketplace_order_id: 'mp', express_receipt_number: 'EX-1', order_items: [] })
    expect(fields.orderLevel.map(({ key }) => key)).toEqual(['express_receipt_number', 'tracking_number'])
    expect(fields.itemLevel).toEqual([])
  })

  it.each([undefined, 'quotation', 'production_confirmation'] as const)('preserves ordinary and %s bill checkboxes on the same sales channel', (source_prebill_document_type) => {
    const fields = reviewFields({ source_prebill_document_type })
    expect(fields.orderLevel.map(({ key }) => key)).toEqual(['channel_order_no', 'tracking_number', 'unit_price'])
    expect(fields.itemLevel.some(({ key }) => key === 'product_name')).toBe(true)
    expect(fields.itemLevel.some(({ key }) => key === 'quantity')).toBe(true)
  })

  it('does not show disabled ETC personalization even if stale values exist', () => {
    const fields = getVisibleFieldsForItem({ product_id: 'p', font: 'F01', line_1: 'stale' }, category, categories, {}, true)
    for (const key of ['font', 'line_1', 'line_2', 'line_3', 'no_name_line'] as const) expect(fields.has(key)).toBe(false)
  })

  it('shows populated lines and required empty lines, respecting overrides', () => {
    const fields = getVisibleFieldsForItem({ product_id: 'p', line_1: 'Alice' }, category, categories, {
      p: { line_1: true, line_2: null, line_2_required: true, font: true },
    }, true)
    expect(fields.has('line_1')).toBe(true)
    expect(fields.has('line_2')).toBe(true)
    expect(fields.has('line_3')).toBe(false)
    expect(fields.has('font')).toBe(true)
    expect(fields.has('no_name_line')).toBe(true)
  })

  it('does not demand text checks when no-name is selected', () => {
    const fields = getVisibleFieldsForItem({ no_name_line: true, line_1: 'stale' }, {}, {}, {}, true)
    expect(fields.has('no_name_line')).toBe(true)
    for (const key of ['line_1', 'line_2', 'line_3'] as const) expect(fields.has(key)).toBe(false)
  })

  it('preserves all original options for ordinary bills and QT/PC', () => {
    const fields = getVisibleFieldsForItem({ no_name_line: true }, {}, {}, {}, false)
    expect(fields.has('no_name_line')).toBe(false)
    for (const key of ['font', 'line_art', 'line_1', 'line_2', 'line_3'] as const) expect(fields.has(key)).toBe(true)
  })
})

describe('Marketplace product and no-name review controls', () => {
  const settingsCases: Record<string, Record<string, boolean>>[] = [{}, { STAMP: { product_name: true, line_1: true } }]
  it.each(settingsCases)('excludes locked controls from review while retaining their detail display', (settings) => {
    const item = { product_id: 'p', product_name: 'Stamp', no_name_line: true, line_1: 'stale' }
    const overrides = { p: { product_name_required: true, line_1_required: true } }
    const details = getVisibleFieldsForItem(item, settings, { p: 'STAMP' }, overrides, true)
    const review = getReviewableFieldsForItem(item, settings, { p: 'STAMP' }, overrides, true)
    expect(details.has('product_name')).toBe(true)
    expect(details.has('no_name_line')).toBe(true)
    expect(review.has('product_name')).toBe(false)
    expect(review.has('no_name_line')).toBe(false)
    expect(details.has('quantity')).toBe(true)
    expect(review.has('quantity')).toBe(false)
    expect(review.has('line_1')).toBe(false)
    expect(review.has('font')).toBe(true)
  })
})
