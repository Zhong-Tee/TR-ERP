/**
 * เตือน "ลืมบันทึกเวลาเข้างาน" — ตัดสินใจล้วนๆ ไม่ยุ่งกับ UI/เครือข่าย
 * ใช้ตอน login: ถ้าวันนี้เป็นวันทำงาน เลยเวลาเข้างานมาแล้ว และยังไม่มีบันทึก clock_in → เตือน
 */

/** คีย์ใน sessionStorage — เตือนครั้งเดียวต่อการ login (ล้างตอน signOut) */
export const MISSED_CLOCK_IN_SHOWN_KEY = 'tr-erp:missed-clockin-shown'

export interface MissedClockInInput {
  /** เวลาปัจจุบัน */
  now: Date
  /** ประเภทของวันนี้ตามตารางงานพนักงาน */
  dayType: 'work' | 'weekly_off' | 'company_holiday'
  /** เวลาเข้างานของพนักงาน 'HH:MM' หรือ 'HH:MM:SS' */
  workStart: string
  /** วันนี้มีบันทึกเข้างานแล้วหรือยัง */
  hasClockIn: boolean
  /** วันนี้มีใบลาที่อนุมัติแล้วครอบคลุมอยู่หรือไม่ */
  onApprovedLeave: boolean
  /** พนักงานอยู่ในรูปแบบที่ต้องบันทึกเวลาเข้าใช่หรือไม่ */
  requiresClockIn: boolean
}

/** 'HH:MM[:SS]' → นาทีนับจากเที่ยงคืน (คืน null ถ้ารูปแบบไม่ถูกต้อง) */
export function parseTimeToMinutes(time: string | null | undefined): number | null {
  if (!time) return null
  const [h, m] = time.slice(0, 5).split(':')
  const hh = Number(h)
  const mm = Number(m)
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
  return hh * 60 + mm
}

/** นาทีที่เลยเวลาเข้างานมาแล้ว — 0 = ยังไม่ถึงเวลา */
export function minutesPastWorkStart(now: Date, workStart: string): number {
  const startMin = parseTimeToMinutes(workStart)
  if (startMin === null) return 0
  return Math.max(0, now.getHours() * 60 + now.getMinutes() - startMin)
}

/** true = ควรเด้ง popup เตือนลืมบันทึกเวลาเข้างาน */
export function shouldWarnMissedClockIn(input: MissedClockInInput): boolean {
  if (!input.requiresClockIn) return false
  if (input.dayType !== 'work') return false
  if (input.hasClockIn) return false
  if (input.onApprovedLeave) return false
  return minutesPastWorkStart(input.now, input.workStart) > 0
}

/** นาที → "1 ชม. 20 นาที" / "20 นาที" */
export function formatLateDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h > 0 && m > 0) return `${h} ชม. ${m} นาที`
  if (h > 0) return `${h} ชม.`
  return `${m} นาที`
}

/** ใบลาที่อนุมัติแล้วครอบคลุมวันที่นี้หรือไม่ (วันที่รูปแบบ YYYY-MM-DD เทียบเป็น string ได้) */
export function coversDate(
  requests: Array<{ start_date: string; end_date: string; status: string }>,
  date: string,
): boolean {
  return requests.some((r) => r.status === 'approved' && r.start_date <= date && r.end_date >= date)
}
