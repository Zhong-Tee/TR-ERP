import { describe, expect, it, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: {} }))
import { canViewPurchaseCost, outstandingQuantity } from './receivingCases'

describe('receiving case quantities and permissions', () => {
  it('subtracts actual receipts, approved closures and active requests separately', () => {
    expect(outstandingQuantity({ qty: 100, qty_received_total: 90, resolution_qty: 4 }, 2)).toBe(4)
    expect(outstandingQuantity({ qty: 10, qty_received_total: 12 })).toBe(0)
    expect(outstandingQuantity({ qty: 1, qty_received_total: 0.7 }, 0.1)).toBe(0.2)
  })
  it.each(['superadmin', 'admin', 'account'])('allows %s to see costs', role => {
    expect(canViewPurchaseCost(role)).toBe(true)
  })
  it.each(['store', 'sales-tr', 'manager', 'picker', undefined])('hides costs from %s', role => {
    expect(canViewPurchaseCost(role)).toBe(false)
  })
})
