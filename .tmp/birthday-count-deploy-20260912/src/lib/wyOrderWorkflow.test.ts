import { describe, expect, it } from 'vitest'
import { isPlanWorkQueueOrder, PLAN_WORK_QUEUE_POSTGREST_FILTER } from './planWorkQueue'
import { computePostSlipVerificationStatus } from './postSlipVerificationStatus'

describe('WY order workflow', () => {
  it('routes manually opened WY bills to verified for every owner role', () => {
    expect(computePostSlipVerificationStatus('sales-tr', 'WY', false)).toBe('ตรวจสอบแล้ว')
    expect(computePostSlipVerificationStatus('sales-pump', 'WY', false)).toBe('ตรวจสอบแล้ว')
    expect(computePostSlipVerificationStatus(null, 'wy', false)).toBe('ตรวจสอบแล้ว')
  })

  it('shows verified WY bills in the new work-order queue only', () => {
    expect(isPlanWorkQueueOrder('ตรวจสอบแล้ว', 'WY')).toBe(true)
    expect(isPlanWorkQueueOrder('ตรวจสอบแล้ว', 'SPTR')).toBe(false)
    expect(isPlanWorkQueueOrder('ใบสั่งงาน', 'SPTR')).toBe(true)
  })

  it('keeps the database queue filter scoped to WY', () => {
    expect(PLAN_WORK_QUEUE_POSTGREST_FILTER).toContain('status.eq.ตรวจสอบแล้ว,channel_code.eq.WY')
  })
})

