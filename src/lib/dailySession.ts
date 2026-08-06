/**
 * บังคับ login ใหม่ทุกเช้า
 *
 * เก็บ "วันของ session" ไว้ตอน login แล้วเทียบกับวันปัจจุบันเป็นระยะ
 * ถ้าข้ามวันไปแล้ว (ผ่านเวลา SESSION_RESET_HOUR ของวันถัดไป) → บังคับออกจากระบบ
 * ใช้เวลา 04:00 เป็นรอยต่อของวัน เพื่อให้คนทำงานดึกข้ามเที่ยงคืนไม่โดนเตะออกกลางคัน
 */
import { localISODate } from './localDate'

export const SESSION_RESET_HOUR = 4

const SESSION_DAY_KEY = 'tr-erp:session-day'

/** วันของ session ปัจจุบัน — เลื่อนถอยหลัง SESSION_RESET_HOUR ชม. ก่อนตัดเป็นวันที่ */
export function sessionDayKey(now: Date = new Date()): string {
  return localISODate(new Date(now.getTime() - SESSION_RESET_HOUR * 60 * 60 * 1000))
}

/** true = session เริ่มมาก่อนเช้าวันนี้ ต้อง login ใหม่ */
export function isSessionExpired(storedDay: string | null, now: Date = new Date()): boolean {
  if (!storedDay) return false
  return storedDay !== sessionDayKey(now)
}

export function readSessionDay(): string | null {
  try {
    return localStorage.getItem(SESSION_DAY_KEY)
  } catch {
    return null
  }
}

/** บันทึกว่า session นี้เริ่มวันไหน (เรียกตอน login สำเร็จ) */
export function markSessionDay(now: Date = new Date()) {
  try {
    localStorage.setItem(SESSION_DAY_KEY, sessionDayKey(now))
  } catch {
    /* storage ไม่พร้อมใช้งาน — ข้าม */
  }
}

export function clearSessionDay() {
  try {
    localStorage.removeItem(SESSION_DAY_KEY)
  } catch {
    /* storage ไม่พร้อมใช้งาน — ข้าม */
  }
}

/** session ที่มีอยู่แล้วแต่ยังไม่เคยบันทึกวัน (เช่นเพิ่งอัปเดตเวอร์ชัน) — นับเป็นเริ่มวันนี้ */
export function ensureSessionDay(now: Date = new Date()) {
  if (!readSessionDay()) markSessionDay(now)
}
