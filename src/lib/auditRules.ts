import type { InventoryAuditItem } from '../types'

export function bangkokDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function auditDateRange(days: number, now = new Date()) {
  const end = new Date(`${bangkokDate(now)}T00:00:00+07:00`)
  const start = new Date(end.getTime() - days * 86400000)
  return { start: bangkokDate(start), end: bangkokDate(new Date(end.getTime() - 86400000)) }
}

export function auditDateBounds(start: string, end: string) {
  const valid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00+07:00`)) && bangkokDate(new Date(`${value}T00:00:00+07:00`)) === value
  if (!valid(start) || !valid(end) || start > end) throw new Error('กรุณาเลือกช่วงวันที่ให้ถูกต้อง')
  return { from: new Date(`${start}T00:00:00+07:00`).toISOString(), to: new Date(Date.parse(`${end}T00:00:00+07:00`) + 86400000).toISOString() }
}

export function auditProductGroup(item: InventoryAuditItem): string {
  return (item.product_type || item.pr_products?.product_type || '').toUpperCase() || 'อื่นๆ'
}

export function compareAuditItems(a: InventoryAuditItem, b: InventoryAuditItem): number {
  const firstLocation = (item: InventoryAuditItem) => item.location_snapshot?.find(row => row.label_type === 'storage')
  const location = (item: InventoryAuditItem) => firstLocation(item)?.code || item.pr_products?.storage_location || (item.count_mode === 'separate' ? '\uffff' : item.storage_location || '\uffff')
  const ranks: Record<string, number> = { RM: 0, FG: 1, ST: 2 }
  return (firstLocation(a)?.sort_order ?? Number.MAX_SAFE_INTEGER) - (firstLocation(b)?.sort_order ?? Number.MAX_SAFE_INTEGER) || location(a).localeCompare(location(b), 'th', { numeric: true }) ||
    (ranks[auditProductGroup(a)] ?? 3) - (ranks[auditProductGroup(b)] ?? 3) ||
    (a.pr_products?.product_code || '').localeCompare(b.pr_products?.product_code || '', 'th', { numeric: true }) || a.id.localeCompare(b.id)
}

export function hasAuditStockDifference(item: InventoryAuditItem): boolean {
  return !!item.is_counted && (Number(item.variance) !== 0 || (item.count_mode === 'separate' && item.counted_safety_stock != null && Number(item.counted_safety_stock) !== Number(item.system_safety_stock || 0)))
}

export function auditAdjustmentTarget(item: InventoryAuditItem) {
  const safety = Number(item.counted_safety_stock ?? item.system_safety_stock ?? 0)
  const normal = item.count_mode === 'separate' ? Number(item.counted_qty) : Number(item.counted_qty) - safety
  if (!Number.isFinite(normal) || !Number.isFinite(safety) || normal < 0 || safety < 0) throw new Error('จำนวนสต๊อคหรือ Safety ไม่ถูกต้อง')
  return { product_id: item.product_id, target_on_hand: normal, target_safety: safety }
}
