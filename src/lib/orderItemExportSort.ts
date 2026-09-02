import { identifyCondoStampItems, isCondoStampItem, isCondoStampProductName } from './condoStamp'

/**
 * ลำดับรายการสำหรับ Export (Excel/คลิปบอร์ด): ตรายางคอนโดเรียงชั้น 1→5 ก่อน
 * แล้วตามด้วยสินค้าอื่น (เรียงตาม created_at, id, item_uid)
 */

export function isCondoTierExportProduct(productName: string | null | undefined): boolean {
  return isCondoStampProductName(productName)
}

/** ดึงเลขชั้นจาก product_type (เช่น ชั้น1) สำหรับเรียงลำดับ */
export function condoFloorSortKey(productType: string | null | undefined): number {
  const s = String(productType ?? '').trim()
  const m = s.match(/ชั้น\s*(\d+)/)
  if (m) {
    const num = parseInt(m[1], 10)
    return Number.isFinite(num) ? num : 999
  }
  return 999
}

export type ExportSortableItem = {
  id?: string | null
  product_id?: string | null
  product_name?: string | null
  product_type?: string | null
  is_detail_row?: boolean | null
  parent_item_id?: string | null
  created_at?: string | null
  item_uid?: string | null
}

function compareItems(a: ExportSortableItem, b: ExportSortableItem, aCondo: boolean, bCondo: boolean): number {
  if (aCondo !== bCondo) return aCondo ? -1 : 1
  if (aCondo && bCondo) {
    const fa = condoFloorSortKey(a.product_type)
    const fb = condoFloorSortKey(b.product_type)
    if (fa !== fb) return fa - fb
  }
  const ta = new Date(a.created_at || 0).getTime()
  const tb = new Date(b.created_at || 0).getTime()
  if (ta !== tb) return ta - tb
  const idCmp = String(a.id || '').localeCompare(String(b.id || ''))
  if (idCmp !== 0) return idCmp
  return String(a.item_uid || '').localeCompare(String(b.item_uid || ''))
}

export function compareExportOrderItems(a: ExportSortableItem, b: ExportSortableItem): number {
  const aC = isCondoTierExportProduct(a.product_name)
  const bC = isCondoTierExportProduct(b.product_name)
  return compareItems(a, b, aC, bC)
}

export function sortOrderItemsForExport<T extends ExportSortableItem>(items: T[]): T[] {
  const condoStampItems = identifyCondoStampItems(items)
  return [...items].sort((a, b) => compareItems(
    a,
    b,
    isCondoStampItem(a, condoStampItems),
    isCondoStampItem(b, condoStampItems),
  ))
}
