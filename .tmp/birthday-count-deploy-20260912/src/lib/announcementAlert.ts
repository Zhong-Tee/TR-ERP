/**
 * Popup "ประกาศที่ยังไม่รับทราบ" — ส่วนตัดสินใจล้วน ๆ ไม่ยุ่งกับ UI/เครือข่าย
 * ใช้ตอน login: มีประกาศที่เผยแพร่แล้วและยังไม่กดรับทราบ → เด้ง popup
 */
import type { HRAnnouncement } from '../types'

/** คีย์ใน sessionStorage — เตือนครั้งเดียวต่อการ login (ล้างตอน signOut) */
export const ANNOUNCEMENT_ALERT_SHOWN_KEY = 'tr-erp:announcement-alert-shown'

/**
 * ประกาศที่ต้องเด้งเตือน = เผยแพร่แล้ว + ยังไม่กดรับทราบ
 * เรียงปักหมุดก่อน แล้วเก่าไปใหม่ เพื่อให้อ่านเรียงตามลำดับที่ประกาศออกมา
 */
export function pickUnacknowledged(
  announcements: HRAnnouncement[],
  readIds: Set<string>,
): HRAnnouncement[] {
  return announcements
    .filter((a) => a.status === 'published' && !readIds.has(a.id))
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      const ta = new Date(a.published_at ?? a.created_at).getTime()
      const tb = new Date(b.published_at ?? b.created_at).getTime()
      return ta - tb
    })
}
