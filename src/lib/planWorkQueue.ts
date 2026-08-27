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

/**
 * WY จบการเปิดบิลที่ "ตรวจสอบแล้ว" และไม่ผ่านคิวรอตรวจคำสั่งซื้อ
 * จึงต้องเพิ่มเฉพาะ WY สถานะนี้เข้าคิวสร้างใบงาน โดยไม่ดึงช่องทางอื่นตามมา
 */
export const PLAN_WORK_QUEUE_POSTGREST_FILTER = [
  `status.in.(${PLAN_WORK_QUEUE_ORDER_STATUSES.join(',')})`,
  'and(status.eq.ตรวจสอบแล้ว,channel_code.eq.WY)',
].join(',')

export function isPlanWorkQueueOrder(status: OrderStatus, channelCode?: string | null): boolean {
  return PLAN_WORK_QUEUE_ORDER_STATUSES.includes(status)
    || (status === 'ตรวจสอบแล้ว' && String(channelCode || '').trim().toUpperCase() === 'WY')
}
