import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllSupabasePages } from './supabasePagination'

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
