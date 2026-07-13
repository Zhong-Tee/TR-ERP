import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * บิลที่ "รายการโอนคืน (โอนเกิน) ล่าสุด" ถูกปฏิเสธ — ใช้แสดงรวมในแท็บ ตรวจสอบไม่ผ่าน
 * เทียบด้วยรายการล่าสุดต่อบิล: ถ้ามีการส่งโอนคืนใหม่ (pending/approved) หลังรายการที่ถูกปฏิเสธ
 * บิลจะหลุดจากรายการนี้ (ถือว่ากำลังดำเนินการต่อแล้ว)
 */
export async function fetchLatestRejectedOverpayOrderIds(client: SupabaseClient): Promise<string[]> {
  const { data } = await client
    .from('ac_refunds')
    .select('order_id, status, created_at')
    .ilike('reason', '%โอนเกิน%')
    .order('created_at', { ascending: false })
    .limit(2000)

  const latestStatusByOrder = new Map<string, string>()
  for (const r of (data || []) as { order_id: string | null; status: string }[]) {
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
  const { data } = await client
    .from('ac_manual_slip_checks')
    .select('order_id, status, submitted_at')
    .order('submitted_at', { ascending: false })
    .limit(4000)

  const latestStatusByOrder = new Map<string, string>()
  for (const r of (data || []) as { order_id: string | null; status: string }[]) {
    if (r.order_id && !latestStatusByOrder.has(r.order_id)) {
      latestStatusByOrder.set(r.order_id, r.status)
    }
  }
  return [...latestStatusByOrder.entries()]
    .filter(([, st]) => st === 'rejected')
    .map(([id]) => id)
}
