import { useEffect, useState } from 'react'

/**
 * ป้ายความเร่งด่วนการจัดส่ง "ส่งด่วน" / "ล่าช้า" (เมนู Marketplace)
 * - ship_due_at / overdue_at คำนวณครั้งเดียวตอน import จาก due_rule ของ config แล้ว freeze
 * - การแสดงผลคำนวณเทียบเวลาปัจจุบันฝั่ง client และหยุดนิ่งที่ shipped_time เมื่อ "จัดส่งแล้ว"
 */

export interface DueRule {
  /** เวลาตัดรอบ (HH:mm เวลาไทย) — ชำระก่อนเวลานี้ = ส่งภายในวัน */
  cutoff_time: string
  /** เวลากำหนดส่งของวันครบกำหนด (HH:mm เวลาไทย) */
  due_time: string
  /** ชำระหลัง cutoff → เลื่อนวันครบกำหนดไป N วัน */
  due_day_offset_after_cutoff: number
  /** เกินกี่ชั่วโมงหลังชำระเงินแล้วยังไม่ส่ง = ล่าช้า */
  overdue_after_hours: number
}

export const DEFAULT_DUE_RULE: DueRule = {
  cutoff_time: '12:00',
  due_time: '23:59',
  due_day_offset_after_cutoff: 1,
  overdue_after_hours: 24,
}

const BKK_TZ = 'Asia/Bangkok'

/** คืนวันที่ YYYY-MM-DD และเวลา HH:mm ของ instant นั้นในเขตเวลาไทย */
function bangkokParts(d: Date): { day: string; time: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: BKK_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts: Record<string, string> = {}
  fmt.formatToParts(d).forEach((p) => { parts[p.type] = p.value })
  // Intl อาจคืนชั่วโมง '24' ที่เที่ยงคืน — normalize เป็น '00'
  const hour = parts.hour === '24' ? '00' : parts.hour
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` }
}

/** วันที่ (YYYY-MM-DD เขตเวลาไทย) ของ instant นั้น */
export function bangkokDayKey(d: Date): string {
  return bangkokParts(d).day
}

function addDays(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function bkkWallClockToUtcIso(dayKey: string, time: string): string {
  return new Date(`${dayKey}T${time}:00+07:00`).toISOString()
}

/**
 * คำนวณ ship_due_at / overdue_at จากเวลาชำระเงิน (ISO UTC) + กติกา
 * คืน null ทั้งคู่เมื่อไม่มีเวลาชำระเงิน
 */
export function computeDueTimestamps(
  paymentTimeIso: string | null | undefined,
  rule: DueRule = DEFAULT_DUE_RULE,
): { ship_due_at: string | null; overdue_at: string | null } {
  if (!paymentTimeIso) return { ship_due_at: null, overdue_at: null }
  const paid = new Date(paymentTimeIso)
  if (Number.isNaN(paid.getTime())) return { ship_due_at: null, overdue_at: null }

  const { day, time } = bangkokParts(paid)
  const beforeCutoff = time < (rule.cutoff_time || DEFAULT_DUE_RULE.cutoff_time)
  const dueDay = beforeCutoff ? day : addDays(day, Math.max(0, rule.due_day_offset_after_cutoff ?? 1))
  const shipDueAt = bkkWallClockToUtcIso(dueDay, rule.due_time || DEFAULT_DUE_RULE.due_time)

  const overdueHours = Number(rule.overdue_after_hours ?? DEFAULT_DUE_RULE.overdue_after_hours)
  const overdueAt = new Date(paid.getTime() + overdueHours * 3600_000).toISOString()

  return { ship_due_at: shipDueAt, overdue_at: overdueAt }
}

export type UrgencyLevel = 'urgent' | 'overdue' | null

export interface UrgencyBadgeSource {
  ship_due_at?: string | null
  overdue_at?: string | null
  status?: string | null
  shipped_time?: string | null
}

/**
 * ป้าย ณ เวลา now: 'overdue' (ล่าช้า) เมื่อเลย overdue_at, 'urgent' (ส่งด่วน) เมื่อถึง/เลยวันครบกำหนด
 * เมื่อสถานะ "จัดส่งแล้ว" ใช้ shipped_time แทน now (ป้าย freeze ถาวร)
 */
export function getUrgencyBadge(order: UrgencyBadgeSource, now: Date = new Date()): UrgencyLevel {
  if (!order?.ship_due_at) return null
  const frozen = order.status === 'จัดส่งแล้ว' && order.shipped_time
  const t = frozen ? new Date(order.shipped_time as string) : now
  if (Number.isNaN(t.getTime())) return null

  if (order.overdue_at) {
    const overdueAt = new Date(order.overdue_at)
    if (!Number.isNaN(overdueAt.getTime()) && t.getTime() >= overdueAt.getTime()) return 'overdue'
  }

  const dueDay = bangkokDayKey(new Date(order.ship_due_at))
  if (dueDay <= bangkokDayKey(t)) return 'urgent'
  return null
}

/** เวลาปัจจุบันที่ refresh อัตโนมัติ — ให้ป้ายเปลี่ยนเองเมื่อเวลาผ่านไป */
export function useNowTick(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
