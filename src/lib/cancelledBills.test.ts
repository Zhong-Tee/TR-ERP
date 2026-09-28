import { describe, expect, it } from 'vitest'
import { cancellationApprovalLabel, latestFullCancellation } from './cancelledBills'
import type { CancellationRequest } from './cancelledBills'

function request(overrides: Partial<CancellationRequest> = {}): CancellationRequest {
  return {
    id: 'request-1', amendment_no: 'AM-001', status: 'executed', reason_type: 'staff_error',
    reason_detail: null, created_at: '2026-09-01T00:00:00Z', changes_json: {},
    requested_by_user: null, approved_by_user: null, ...overrides,
  }
}

describe('cancelled bill approval', () => {
  it('does not treat a direct cancellation as approved', () => {
    expect(latestFullCancellation([])).toBeUndefined()
    expect(cancellationApprovalLabel()).toBe('ไม่มีคำขออนุมัติ')
  })

  it('excludes partial amendments when selecting the latest full cancellation', () => {
    const full = request()
    const partial = request({ id: 'partial', created_at: '2026-09-02T00:00:00Z', changes_json: { remove_item_ids: ['item-1'] } })
    expect(latestFullCancellation([partial, full])).toEqual(full)
    expect(latestFullCancellation([partial])).toBeUndefined()
  })

  it('uses the latest request regardless of the returned order without mutating input', () => {
    const previous = request()
    const pending = request({ id: 'pending', status: 'pending', created_at: '2026-09-03T00:00:00Z', changes_json: null })
    const requests = [previous, pending]
    expect(latestFullCancellation(requests)).toEqual(pending)
    expect(requests).toEqual([previous, pending])
    expect(cancellationApprovalLabel(pending.status)).toContain('รออนุมัติ')
  })

  it('distinguishes approved requests from rejected requests', () => {
    expect(cancellationApprovalLabel('approved')).toBe('อนุมัติยกเลิกแล้ว')
    expect(cancellationApprovalLabel('executed')).toBe('อนุมัติยกเลิกแล้ว')
    expect(cancellationApprovalLabel('rejected')).toBe('คำขอถูกปฏิเสธ')
  })
})
