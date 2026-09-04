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

/**
 * ใช้เฉพาะหน้ารายละเอียดบิล: ตรายางคอนโดหลายชิ้นต้องแสดงเป็นชุด
 * (ชุดแรก ชั้น 1→5 แล้วจึงชุดถัดไป ชั้น 1→5) เพื่อไม่ให้ชั้นเดียวกัน
 * ของคนละชิ้นสลับกัน ส่วนลำดับสำหรับ QC/แพ็ค/Export ยังคงใช้ฟังก์ชันเดิม
 */
export function sortOrderItemsForBillDisplay<T extends ExportSortableItem>(items: T[]): T[] {
  const condoStampItems = identifyCondoStampItems(items)
  const sourceIndex = new Map<T, number>(items.map((item, index) => [item, index]))
  const referencedParentIds = new Set(
    items
      .map((item) => String(item.parent_item_id || '').trim())
      .filter(Boolean),
  )

  const groupKey = (item: T): string => {
    const parentId = String(item.parent_item_id || '').trim()
    if (parentId) return `parent:${parentId}`

    const itemId = String(item.id || '').trim()
    if (itemId && referencedParentIds.has(itemId)) return `parent:${itemId}`

    const productId = String(item.product_id || '').trim()
    if (productId) return `product:${productId}`

    const productName = String(item.product_name || '').trim()
    return productName ? `name:${productName}` : `row:${sourceIndex.get(item) ?? 0}`
  }

  const groupFirstIndex = new Map<string, number>()
  items.forEach((item, index) => {
    if (!isCondoStampItem(item, condoStampItems)) return
    const key = groupKey(item)
    if (!groupFirstIndex.has(key)) groupFirstIndex.set(key, index)
  })

  return [...items].sort((a, b) => {
    const aCondo = isCondoStampItem(a, condoStampItems)
    const bCondo = isCondoStampItem(b, condoStampItems)
    if (aCondo !== bCondo) return aCondo ? -1 : 1

    if (aCondo && bCondo) {
      const groupDiff = (groupFirstIndex.get(groupKey(a)) ?? 0) - (groupFirstIndex.get(groupKey(b)) ?? 0)
      if (groupDiff !== 0) return groupDiff

      const floorDiff = condoFloorSortKey(a.product_type) - condoFloorSortKey(b.product_type)
      if (floorDiff !== 0) return floorDiff
    }

    return compareItems(a, b, aCondo, bCondo) ||
      (sourceIndex.get(a) ?? 0) - (sourceIndex.get(b) ?? 0)
  })
}
