import { describe, expect, it } from 'vitest'
import { buildClaimRevisionSnapshot, failedClaimEditAction } from './claimReapproval'

describe('claim reapproval', () => {
  it('recalculates totals and excludes free items', () => {
    const snapshot = buildClaimRevisionSnapshot([
      { edit_key: 'a', product_name: 'สินค้า A', quantity: 2, unit_price: 50 },
      { edit_key: 'b', product_name: 'ของแถม', quantity: 1, unit_price: 999, is_free: true },
    ], 30, 10)

    expect(snapshot.order).toEqual({
      price: 100,
      shipping_cost: 30,
      discount: 10,
      total_amount: 120,
    })
    expect(snapshot.items[0]).not.toHaveProperty('edit_key')
  })

  it('requires reapproval before slip verification when bill data changed', () => {
    expect(failedClaimEditAction({ billChanged: true, newSlipCount: 1 })).toBe('submit_reapproval')
    expect(failedClaimEditAction({ billChanged: false, newSlipCount: 1 })).toBe('verify_slip')
    expect(failedClaimEditAction({ billChanged: false, newSlipCount: 0 })).toBe('none')
  })
})
