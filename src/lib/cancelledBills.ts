export type CancellationRequest = {
  id: string
  amendment_no: string
  status: string
  reason_type: string
  reason_detail: string | null
  created_at: string
  changes_json: Record<string, unknown> | null
  requested_by_user: { username: string | null; email: string | null } | null
  approved_by_user: { username: string | null; email: string | null } | null
}

export function latestFullCancellation(requests: CancellationRequest[]): CancellationRequest | undefined {
  // Partial item removals must not count as approval to cancel the whole bill.
  return requests
    .filter((request) => !Object.prototype.hasOwnProperty.call(request.changes_json ?? {}, 'remove_item_ids'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0]
}

export function cancellationApprovalLabel(status?: string): string {
  switch (status) {
    case 'executed':
    case 'approved': return 'อนุมัติยกเลิกแล้ว'
    case 'pending': return 'ขออนุมัติยกเลิกแล้ว (รออนุมัติ)'
    case 'rejected': return 'คำขอถูกปฏิเสธ'
    case undefined: return 'ไม่มีคำขออนุมัติ'
    default: return status
  }
}
