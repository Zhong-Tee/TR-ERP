import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllSupabasePages } from './supabasePagination'

type ClaimReapprovalState = {
  status: string
  reviewed_at: string | null
  reapproval_count: number | null
}

export function isManualSlipRejectionSuperseded(
  manualSubmittedAt: string,
  revision?: ClaimReapprovalState,
): boolean {
  if (!revision || Number(revision.reapproval_count) < 1) return false
  if (revision.status === 'pending') return true
  if (revision.status !== 'approved' || !revision.reviewed_at) return false
  const reviewedAt = new Date(revision.reviewed_at).getTime()
  const submittedAt = new Date(manualSubmittedAt).getTime()
  return Number.isFinite(reviewedAt) && Number.isFinite(submittedAt) && reviewedAt > submittedAt
}

/**
 * บิลที่ "รายการโอนคืน (โอนเกิน) ล่าสุด" ถูกปฏิเสธ — ใช้แสดงรวมในแท็บ ตรวจสอบไม่ผ่าน
 * เทียบด้วยรายการล่าสุดต่อบิล: ถ้ามีการส่งโอนคืนใหม่ (pending/approved) หลังรายการที่ถูกปฏิเสธ
 * บิลจะหลุดจากรายการนี้ (ถือว่ากำลังดำเนินการต่อแล้ว)
 */
export async function fetchLatestRejectedOverpayOrderIds(client: SupabaseClient): Promise<string[]> {
  const data = await fetchAllSupabasePages<{ id: string; order_id: string | null; status: string; created_at: string }>((from, to) => client
    .from('ac_refunds')
    .select('id, order_id, status, created_at')
    .ilike('reason', '%โอนเกิน%')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to))

  const latestStatusByOrder = new Map<string, string>()
  for (const r of data) {
    if (r.order_id && !latestStatusByOrder.has(r.order_id)) {
      latestStatusByOrder.set(r.order_id, r.status)
    }
  }
  return [...latestStatusByOrder.entries()]
    .filter(([, st]) => st === 'rejected')
    .map(([id]) => id)
}

/**
 * บิลที่ "การตรวจสลิปมือล่าสุด" ถูกปฏิเสธ (ac_manual_slip_checks) — ใช้แสดงรวมในแท็บ ตรวจสอบไม่ผ่าน
 * เทียบด้วยการส่งตรวจล่าสุดต่อบิล: ถ้าถูกส่งตรวจใหม่ (pending) หรืออนุมัติแล้ว บิลจะหลุดจากรายการนี้
 */
export async function fetchLatestRejectedManualSlipOrderIds(client: SupabaseClient): Promise<string[]> {
  const data = await fetchAllSupabasePages<{ id: string; order_id: string | null; status: string; submitted_at: string }>((from, to) => client
    .from('ac_manual_slip_checks')
    .select('id, order_id, status, submitted_at')
    .order('submitted_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to))

  const latestByOrder = new Map<string, { status: string; submitted_at: string }>()
  for (const r of data) {
    if (r.order_id && !latestByOrder.has(r.order_id)) {
      latestByOrder.set(r.order_id, { status: r.status, submitted_at: r.submitted_at })
    }
  }

  const rejected = [...latestByOrder.entries()].filter(([, row]) => row.status === 'rejected')
  if (rejected.length === 0) return []

  // A claim-bill revision supersedes the old rejected manual-slip result while
  // it is pending, and after approval when the approval happened later than
  // that rejection. A newer manual rejection must still return to this queue.
  const revisionRows = await fetchAllSupabasePages<ClaimReapprovalState & {
    created_claim_order_id: string | null
  }>((from, to) => client
    .from('or_claim_requests')
    .select('created_claim_order_id, status, reviewed_at, reapproval_count')
    .not('created_claim_order_id', 'is', null)
    .gt('reapproval_count', 0)
    .in('status', ['pending', 'approved'])
    .order('created_at', { ascending: false })
    .range(from, to))

  const revisionByOrder = new Map(
    revisionRows
      .filter((row) => Boolean(row.created_claim_order_id))
      .map((row) => [row.created_claim_order_id as string, row]),
  )

  return rejected
    .filter(([orderId, manualCheck]) => {
      const revision = revisionByOrder.get(orderId)
      return !isManualSlipRejectionSuperseded(manualCheck.submitted_at, revision)
    })
    .map(([orderId]) => orderId)
}
