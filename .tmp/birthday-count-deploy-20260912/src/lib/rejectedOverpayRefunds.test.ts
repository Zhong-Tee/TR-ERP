import { describe, expect, it } from 'vitest'
import { isManualSlipRejectionSuperseded } from './rejectedOverpayRefunds'

describe('manual-slip rejection queue', () => {
  it('hides an old rejection while a claim revision is pending', () => {
    expect(isManualSlipRejectionSuperseded('2026-09-10T03:00:00Z', {
      status: 'pending',
      reviewed_at: null,
      reapproval_count: 1,
    })).toBe(true)
  })

  it('hides a rejection superseded by a later claim revision approval', () => {
    expect(isManualSlipRejectionSuperseded('2026-09-10T03:00:00Z', {
      status: 'approved',
      reviewed_at: '2026-09-11T03:00:00Z',
      reapproval_count: 1,
    })).toBe(true)
  })

  it('keeps a newer manual rejection visible', () => {
    expect(isManualSlipRejectionSuperseded('2026-09-12T03:00:00Z', {
      status: 'approved',
      reviewed_at: '2026-09-11T03:00:00Z',
      reapproval_count: 1,
    })).toBe(false)
  })
})
