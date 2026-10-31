import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchLatestRejectedManualSlipOrderIds, isManualSlipRejectionSuperseded, isManualSlipRevocationSuperseded, latestRefundsByOrder } from './rejectedOverpayRefunds'

describe('manual approval revoked before customer waiver', () => {
  const manual = { status: 'rejected', approval_revoked_at: '2026-10-31T04:50:00Z' }
  const waiver = { status: 'approved', created_at: '2026-10-31T05:00:00Z', reviewed_at: '2026-10-31T05:10:00Z' }

  it('clears the old revocation after a newer waiver is approved', () => {
    expect(isManualSlipRevocationSuperseded(manual, waiver)).toBe(true)
  })

  it('keeps pending, rejected, superseded and older waiver decisions from clearing a rejection', () => {
    for (const status of ['pending', 'rejected', 'superseded']) {
      expect(isManualSlipRevocationSuperseded(manual, { ...waiver, status })).toBe(false)
    }
    expect(isManualSlipRevocationSuperseded(manual, { ...waiver, created_at: '2026-10-31T04:00:00Z' })).toBe(false)
    expect(isManualSlipRevocationSuperseded(manual, { ...waiver, reviewed_at: null })).toBe(false)
    expect(isManualSlipRevocationSuperseded({ ...manual, approval_revoked_at: '2026-10-31T05:20:00Z' }, waiver)).toBe(false)
  })

  it('preserves genuine payment rejections even when a waiver is approved', () => {
    expect(isManualSlipRevocationSuperseded({ status: 'rejected', approval_revoked_at: null }, waiver)).toBe(false)
    expect(isManualSlipRevocationSuperseded({ status: 'pending', approval_revoked_at: manual.approval_revoked_at }, waiver)).toBe(false)
  })

  it('removes resolved revocations from queue IDs and counts while retaining fresh failures', async () => {
    const rows: Record<string, unknown[]> = {
      ac_manual_slip_checks: [
        { ...manual, id: 'm1', order_id: 'resolved', submitted_at: '2026-10-31T04:00:00Z' },
        { ...manual, id: 'm2', order_id: 'fresh', submitted_at: '2026-10-31T05:20:00Z', approval_revoked_at: '2026-10-31T05:21:00Z' },
        { id: 'm3', order_id: 'actual-failure', status: 'rejected', submitted_at: '2026-10-31T04:00:00Z', approval_revoked_at: null },
      ],
      ac_overpayment_waivers: ['resolved', 'fresh', 'actual-failure'].map(order_id => ({ ...waiver, id: `w-${order_id}`, order_id })),
      or_claim_requests: [],
    }
    const client = {
      from(table: string) {
        const query = {
          select: () => query, is: () => query, not: () => query, gt: () => query,
          in: () => query, order: () => query,
          range: () => Promise.resolve({ data: rows[table], error: null }),
        }
        return query
      },
    } as unknown as SupabaseClient
    expect(await fetchLatestRejectedManualSlipOrderIds(client)).toEqual(['fresh', 'actual-failure'])
  })
})

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
