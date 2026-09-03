import { describe, expect, it } from 'vitest'
import { isWmsPickableProduct } from './wmsUtils'

describe('isWmsPickableProduct', () => {
  const nonPicker = new Set(['PACKAGING'])
  const subWarehouse = new Set(['sub-product'])

  it('sends a normal unconfigured product to the Picker', () => {
    expect(isWmsPickableProduct('main-product', 'STAMP', nonPicker, subWarehouse)).toBe(true)
  })

  it('skips a configured non-Picker category', () => {
    expect(isWmsPickableProduct('main-product', ' packaging ', nonPicker, subWarehouse)).toBe(false)
  })

  it('skips Picker for a product assigned to an active sub warehouse', () => {
    expect(isWmsPickableProduct('sub-product', 'STAMP', nonPicker, subWarehouse)).toBe(false)
  })

  it('does not send a product with no category to the Picker', () => {
    expect(isWmsPickableProduct('main-product', null, nonPicker, subWarehouse)).toBe(false)
  })
})
