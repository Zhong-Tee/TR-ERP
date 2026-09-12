import { describe, expect, it } from 'vitest'
import {
  resolveFieldEnabled,
  resolveFieldRequired,
  type FieldRuleMaps,
} from './productFieldRules'

const product = { id: 'p1', product_category: 'CAT' }

function maps(value: boolean | null | 'required'): FieldRuleMaps {
  return {
    categorySettings: { CAT: { notes: false } },
    productOverrides: { p1: { notes: value } },
  }
}

describe('product field override rules', () => {
  it('keeps the existing enabled override non-required', () => {
    expect(resolveFieldEnabled(product, 'notes', maps(true))).toBe(true)
    expect(resolveFieldRequired(product, 'notes', maps(true))).toBe(false)
  })

  it('treats required override as enabled and required', () => {
    expect(resolveFieldEnabled(product, 'notes', maps('required'))).toBe(true)
    expect(resolveFieldRequired(product, 'notes', maps('required'))).toBe(true)
  })

  it('inherits category visibility without making the field required', () => {
    expect(resolveFieldEnabled(product, 'notes', maps(null))).toBe(false)
    expect(resolveFieldRequired(product, 'notes', maps(null))).toBe(false)
  })
})
