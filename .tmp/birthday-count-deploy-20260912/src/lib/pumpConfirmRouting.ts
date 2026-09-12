import type { OrderStatus } from '../types'

/** หลังตรวจสลิป/อนุมัติแล้ว: ช่องทาง PUMP แยกคิว Confirm ตาม requires_confirm_design */
export function pumpVerifiedRoutingStatus(requiresConfirmDesign: boolean): Extract<OrderStatus, 'ตรวจสอบแล้ว' | 'ไม่ต้องออกแบบ'> {
  return requiresConfirmDesign ? 'ตรวจสอบแล้ว' : 'ไม่ต้องออกแบบ'
}

/**
 * บิลที่ควรอยู่ในคิว Confirm (บอร์ด / unread / ตัวนับ):
 * - PUMP: ทุกบิลในสถานะ pipeline (แยก งานใหม่ vs ไม่ต้องออกแบบ ตาม routing)
 * - ช่องอื่น: เฉพาะเมื่อติ๊ก "ออกแบบ" (requires_confirm_design = true) — ไม่ติ๊กจะไม่ขึ้นบอร์ดแม้สถานะตรวจสอบแล้ว
 */
export function orderQualifiesForConfirmBoard(
  channelCode: string | null | undefined,
  requiresConfirmDesign: boolean | null | undefined,
): boolean {
  const ch = (channelCode ?? '').trim()
  if (ch === 'PUMP') return true
  return requiresConfirmDesign === true
}
