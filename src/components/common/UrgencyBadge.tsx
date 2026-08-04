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

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold whitespace-nowrap ${style} ${className}`}>
      {level === 'overdue' ? 'ล่าช้า' : 'ส่งด่วน'}
    </span>
  )
}

/** ข้อมูลกำหนดส่งของบิลหนึ่งใบ ใช้สรุประดับใบงาน */
export interface DueBillInfo {
  ship_due_at: string | null
  overdue_at: string | null
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
          ส่งด่วน {urgent} บิล
        </span>
      )}
    </>
  )
}
