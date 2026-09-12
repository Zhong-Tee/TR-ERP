export type ChatDeliveryStatus = 'sent' | 'read'

export interface ChatReceiptMessage {
  order_id: string
  sender_id: string
  created_at: string
}

export interface ChatReceiptRead {
  order_id: string
  user_id: string
  last_read_at: string
}

/** สถานะของข้อความล่าสุดที่ผู้ใช้ส่งในแต่ละห้อง: มีข้อความ = sent, ผู้ใช้อื่นอ่านหลังส่ง = read */
export function deriveChatDeliveryStatuses(
  currentUserId: string,
  messages: ChatReceiptMessage[],
  reads: ChatReceiptRead[],
): Record<string, ChatDeliveryStatus> {
  const latestOwnByOrder = new Map<string, number>()
  messages.forEach((message) => {
    if (message.sender_id !== currentUserId) return
    const sentAt = new Date(message.created_at).getTime()
    if (Number.isNaN(sentAt)) return
    latestOwnByOrder.set(message.order_id, Math.max(latestOwnByOrder.get(message.order_id) || 0, sentAt))
  })

  const result: Record<string, ChatDeliveryStatus> = {}
  latestOwnByOrder.forEach((sentAt, orderId) => {
    const readByOther = reads.some((read) => {
      if (read.order_id !== orderId || read.user_id === currentUserId) return false
      const readAt = new Date(read.last_read_at).getTime()
      return !Number.isNaN(readAt) && readAt >= sentAt
    })
    result[orderId] = readByOther ? 'read' : 'sent'
  })
  return result
}
