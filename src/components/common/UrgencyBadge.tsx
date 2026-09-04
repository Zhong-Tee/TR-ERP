import { getUrgencyBadge, useNowTick, type UrgencyBadgeSource } from '../../lib/shipDueBadge'

/**
 * ป้าย ส่งด่วน/ล่าช้า หลังเลขบิล — แสดงเฉพาะบิลที่มี ship_due_at (มาจากเมนู Marketplace)
 * อัปเดตตามเวลาปัจจุบันอัตโนมัติ และ freeze เมื่อสถานะ "จัดส่งแล้ว"
 */
export default function UrgencyBadge({ order, className = '' }: { order: UrgencyBadgeSource | null | undefined; className?: string }) {
  const now = useNowTick()
  if (!order) return null
  const level = getUrgencyBadge(order, now)
  if (!level) return null

  const style = level === 'overdue'
    ? 'bg-red-100 text-red-700 border border-red-300'
    : 'bg-orange-100 text-orange-700 border border-orange-300'

  const shippingLabel = order.urgency_label?.trim() || 'ส่งวันนี้'
  const colorStyles: Record<string, string> = {
    blue: 'bg-blue-100 text-blue-700 border-blue-300',
    orange: 'bg-orange-100 text-orange-700 border-orange-300',
    green: 'bg-green-100 text-green-700 border-green-300',
    purple: 'bg-purple-100 text-purple-700 border-purple-300',
    pink: 'bg-pink-100 text-pink-700 border-pink-300',
    slate: 'bg-slate-100 text-slate-700 border-slate-300',
  }
  const shippingStyle = colorStyles[order.urgency_color || ''] || (order.urgency_label ? colorStyles.orange : colorStyles.blue)
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap border ${shippingStyle}`}>
        {shippingLabel}
      </span>
      {level === 'overdue' && (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${style}`}>
          ล่าช้า
        </span>
      )}
    </span>
  )
}

/** ข้อมูลกำหนดส่งของบิลหนึ่งใบ ใช้สรุประดับใบงาน */
export interface DueBillInfo {
  ship_due_at: string | null
  overdue_at: string | null
  urgency_label?: string | null
  urgency_color?: string | null
  shipped_time?: string | null
}

/**
 * ป้ายสรุประดับใบงาน — นับจำนวนบิล "ล่าช้า" / "ส่งด่วน" จากบิลในใบงาน
 * ใช้ในหน้า จัดสินค้า / QC / จัดของ เพื่อเฝ้าระวังงานจากเมนู Marketplace
 */
export function WoUrgencyChips({ bills, className = '' }: { bills: DueBillInfo[] | null | undefined; className?: string }) {
  const now = useNowTick()
  if (!bills || bills.length === 0) return null

  let overdue = 0
  let urgent = 0
  bills.forEach((b) => {
    const level = getUrgencyBadge(b, now)
    if (level === 'overdue') overdue++
    else if (level === 'urgent') urgent++
  })
  if (overdue === 0 && urgent === 0) return null

  return (
    <>
      {overdue > 0 && (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap bg-red-100 text-red-700 border border-red-300 ${className}`}>
          ล่าช้า {overdue} บิล
        </span>
      )}
      {urgent > 0 && (
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap bg-orange-100 text-orange-700 border border-orange-300 ${className}`}>
          ส่งวันนี้ {urgent} บิล
        </span>
      )}
    </>
  )
}
