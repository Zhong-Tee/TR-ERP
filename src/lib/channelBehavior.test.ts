import { describe, expect, it } from 'vitest'
import { isSelfPickupChannel } from './channelBehavior'

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
})
