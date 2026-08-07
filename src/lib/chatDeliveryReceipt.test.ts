import { describe, expect, it } from 'vitest'
import { deriveChatDeliveryStatuses } from './chatDeliveryReceipt'

describe('deriveChatDeliveryStatuses', () => {
  const messages = [{ order_id: 'order-1', sender_id: 'sender', created_at: '2026-08-07T02:00:00Z' }]

  it('แสดง sent เมื่อส่งแล้วแต่ยังไม่มีผู้ใช้อื่นอ่าน', () => {
    expect(deriveChatDeliveryStatuses('sender', messages, [])).toEqual({ 'order-1': 'sent' })
  })

  it('ไม่นับการอ่านของผู้ส่งเองเป็น read receipt', () => {
    const reads = [{ order_id: 'order-1', user_id: 'sender', last_read_at: '2026-08-07T02:01:00Z' }]
    expect(deriveChatDeliveryStatuses('sender', messages, reads)).toEqual({ 'order-1': 'sent' })
  })

  it('แสดง read เมื่อผู้ใช้อื่นอ่านหลังข้อความล่าสุด', () => {
    const reads = [{ order_id: 'order-1', user_id: 'receiver', last_read_at: '2026-08-07T02:05:00Z' }]
    expect(deriveChatDeliveryStatuses('sender', messages, reads)).toEqual({ 'order-1': 'read' })
  })
})
