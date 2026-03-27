import type { OrderStatus } from '../types'

/** หลังตรวจสลิป/อนุมัติแล้ว: ช่องทาง PUMP แยกคิว Confirm ตาม requires_confirm_design */
export function pumpVerifiedRoutingStatus(requiresConfirmDesign: boolean): Extract<OrderStatus, 'ตรวจสอบแล้ว' | 'ไม่ต้องออกแบบ'> {
  return requiresConfirmDesign ? 'ตรวจสอบแล้ว' : 'ไม่ต้องออกแบบ'
}
