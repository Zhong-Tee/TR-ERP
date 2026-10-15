import { describe, expect, it } from 'vitest'
import { getVisibleFieldsForItem } from './OrderReviewList'

const category = { ETC: { font: false, line_1: false, line_2: false, line_3: false } }
const categories = { p: 'ETC' }

describe('Marketplace review field selection', () => {
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
