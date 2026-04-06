import type { OrderStatus } from '../types'

/**
 * บิลที่ยังไม่ถูกใส่ใบงาน — แสดงใน Plan → ใบสั่งงาน
 * (ตรวจออเดอร์ → ใบสั่งงาน, Confirm → คอนเฟิร์มแล้ว/เสร็จสิ้น, ย้ายจากใบงาน)
 */
export const PLAN_WORK_QUEUE_ORDER_STATUSES: OrderStatus[] = [
  'ใบสั่งงาน',
  'คอนเฟิร์มแล้ว',
  'เสร็จสิ้น',
  'ย้ายจากใบงาน',
]
