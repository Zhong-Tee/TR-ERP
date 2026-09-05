import { describe, expect, it } from 'vitest'
import { flatBillUnitUid, stableOrderItemUnitKey } from './productionUnits'

describe('production unit identities', () => {
  it('keeps the printed bill UID format unchanged', () => {
    expect(flatBillUnitUid('BILL-100', 2)).toBe('BILL-100-2')
  })

  it('uses the immutable order item and its own unit index internally', () => {
    expect(stableOrderItemUnitKey('item-a', 1)).toBe('item-a\u00011')
    expect(stableOrderItemUnitKey('item-a', 2)).not.toBe(stableOrderItemUnitKey('item-a', 1))
    expect(stableOrderItemUnitKey('item-b', 1)).not.toBe(stableOrderItemUnitKey('item-a', 1))
  })
})
