import { describe, expect, it } from 'vitest'
import { isManualSlipRejectionSuperseded, latestRefundsByOrder } from './rejectedOverpayRefunds'

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

describe('latest refund decision', () => {
  it('replaces the old rejected badge with the resubmission, then approval', () => {
    const rejected = { id: '1', order_id: 'bill', created_at: '2026-10-12T07:49:50Z', status: 'rejected' }
    const replacement = { id: '2', order_id: 'bill', created_at: '2026-10-12T09:17:03Z', status: 'pending' }
    expect(latestRefundsByOrder([replacement, rejected]).get('bill')?.status).toBe('pending')
    expect(latestRefundsByOrder([rejected, { ...replacement, status: 'approved' }]).get('bill')?.status).toBe('approved')
    expect(latestRefundsByOrder([rejected]).get('bill')?.status).toBe('rejected')
  })
  it('breaks creation-time ties deterministically and keeps bills separate', () => {
    const base = { order_id: 'a', created_at: '2026-10-12T09:17:03Z' }
    const rows = [{ ...base, id: 'b', status: 'approved' }, { ...base, id: 'a', status: 'rejected' }, { ...base, id: 'c', order_id: 'other', status: 'pending' }]
    expect(latestRefundsByOrder(rows).get('a')?.status).toBe('approved')
    expect(latestRefundsByOrder(rows).get('other')?.status).toBe('pending')
  })
})
