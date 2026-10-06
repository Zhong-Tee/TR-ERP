import { describe, expect, it } from 'vitest'
import { isSelfPickupBill, isSelfPickupChannel, resolveBillFulfillmentMethod } from './channelBehavior'

describe('isSelfPickupChannel', () => {
  it('recognizes SHOPP regardless of surrounding whitespace or case', () => {
    expect(isSelfPickupChannel('SHOPP')).toBe(true)
    expect(isSelfPickupChannel(' shopp ')).toBe(true)
  })

  it('does not exempt shipping channels from parcel tracking', () => {
    expect(isSelfPickupChannel('SHOP')).toBe(false)
    expect(isSelfPickupChannel('SPTR')).toBe(false)
    expect(isSelfPickupChannel(null)).toBe(false)
  })

  it('uses channel metadata as the source of truth when available', () => {
    const metadata = {
      SHOPP: { is_self_pickup: false },
      WALKIN: { is_self_pickup: true },
    }

    expect(isSelfPickupChannel('SHOPP', metadata)).toBe(false)
    expect(isSelfPickupChannel('walkin', metadata)).toBe(true)
  })
})

describe('isSelfPickupBill', () => {
  const metadata = { SHOPP: { is_self_pickup: true } }

  it('allows a bill-level shipping conversion to override a pickup channel', () => {
    expect(isSelfPickupBill('shipping', 'SHOPP', metadata)).toBe(false)
  })

  it('uses the channel default before a bill-level method exists', () => {
    expect(isSelfPickupBill(undefined, 'SHOPP', metadata)).toBe(true)
  })
})

describe('resolveBillFulfillmentMethod', () => {
  const metadata = { SHOP: { is_self_pickup: false }, SHOPP: { is_self_pickup: true }, 'OATR-P': { is_self_pickup: true } }
  it('uses the new channel default when changing a bill channel', () => {
    expect(resolveBillFulfillmentMethod('shipping', 'OATR-P', 'SHOP', metadata)).toBe('self_pickup')
    expect(resolveBillFulfillmentMethod('self_pickup', 'SHOP', 'SHOPP', metadata)).toBe('shipping')
  })
  it('retains sales-approved shipping on a pickup channel', () => {
    expect(resolveBillFulfillmentMethod('shipping', 'SHOPP', 'SHOPP', metadata)).toBe('shipping')
  })
  it('keeps historical pickup after a channel default changes', () => {
    expect(resolveBillFulfillmentMethod('self_pickup', 'SHOP', 'SHOP', metadata)).toBe('self_pickup')
  })
  it('normalizes channel codes and initializes new bills from metadata', () => {
    expect(resolveBillFulfillmentMethod('shipping', ' shopp ', 'SHOPP', metadata)).toBe('shipping')
    expect(resolveBillFulfillmentMethod(undefined, 'OATR-P', undefined, metadata)).toBe('self_pickup')
  })
})
