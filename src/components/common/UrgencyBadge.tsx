import { getUrgencyBadge, useNowTick, type UrgencyBadgeSource } from '../../lib/shipDueBadge'

/**
 * ป้าย ส่งด่วน/ล่าช้า หลังเลขบิล — แสดงเฉพาะบิลที่มี ship_due_at (มาจากเมนู Marketplace)
 * อัปเดตตามเวลาปัจจุบันอัตโนมัติ และ freeze เมื่อสถานะ "จัดส่งแล้ว"
 */
export default function UrgencyBadge({ order, className = '' }: { order: UrgencyBadgeSource; className?: string }) {
  const now = useNowTick()
  const level = getUrgencyBadge(order, now)
  if (!level) return null

  const style = level === 'overdue'
    ? 'bg-red-100 text-red-700 border border-red-300'
    : 'bg-orange-100 text-orange-700 border border-orange-300'

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${style} ${className}`}>
      {level === 'overdue' ? 'ล่าช้า' : 'ส่งด่วน'}
    </span>
  )
}
