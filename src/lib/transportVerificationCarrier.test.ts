import { describe, expect, it } from 'vitest'
import { listVerificationCarriers, resolveVerificationCarrier } from './transportVerificationCarrier'

const channels = [
  { channel_code: 'FBTR', default_carrier: 'FLASH', is_self_pickup: false },
  { channel_code: 'FSPTR', default_carrier: 'SPX', is_self_pickup: false },
  { channel_code: 'LZTR', default_carrier: 'LZ', is_self_pickup: false },
  { channel_code: 'OFFICE', default_carrier: null, is_self_pickup: false },
  { channel_code: 'SHOPP', default_carrier: 'SELF', is_self_pickup: true },
  { channel_code: 'SECOND-FLASH', default_carrier: ' flash ', is_self_pickup: false },
]

describe('transport verification carrier mapping', () => {
  it('resolves the carrier from the bill channel setting', () => {
    expect(resolveVerificationCarrier('fbtr', channels)).toBe('FLASH')
    expect(resolveVerificationCarrier('LZTR', channels)).toBe('LZ')
  })

  it('falls back to OTHER when the channel or setting is missing', () => {
    expect(resolveVerificationCarrier('OFFICE', channels)).toBe('OTHER')
    expect(resolveVerificationCarrier('UNKNOWN', channels)).toBe('OTHER')
  })

  it('lists distinct configured carriers and excludes self pickup', () => {
    expect(listVerificationCarriers(channels)).toEqual(['FLASH', 'LZ', 'OTHER', 'SPX'])
  })
})
