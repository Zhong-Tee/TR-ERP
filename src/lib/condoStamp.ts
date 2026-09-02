export type CondoStampItemLike = {
  id?: string | null
  product_id?: string | null
  product_name?: string | null
  is_detail_row?: boolean | null
  parent_item_id?: string | null
}

export type CondoStampItemIdentity = {
  itemIds: Set<string>
  productIds: Set<string>
}

const CONDO_STAMP_CATEGORY_PATTERN = /^CONDO STAMP (?:2|3|5)FL$/i

export function isCondoStampCategory(category: string | null | undefined): boolean {
  return CONDO_STAMP_CATEGORY_PATTERN.test(String(category ?? '').trim())
}

/** Fallback สำหรับบิลเก่าที่สร้างก่อนมี is_detail_row/parent_item_id */
export function isCondoStampProductName(productName: string | null | undefined): boolean {
  return String(productName ?? '').trim().startsWith('ตรายางคอนโด')
}

/**
 * ระบุรายการตรายางคอนโดทั้งแถวหลักและแถวรายละเอียด โดยยึดโครงสร้างรายการ
 * และหมวดสินค้าเป็นหลัก พร้อม fallback จากชื่อสำหรับข้อมูลเก่า
 */
export function identifyCondoStampItems(
  items: CondoStampItemLike[],
  productCategoryByProductId: Record<string, string> = {},
): CondoStampItemIdentity {
  const itemIds = new Set<string>()
  const productIds = new Set<string>()

  for (const item of items) {
    const itemId = String(item.id ?? '').trim()
    const productId = String(item.product_id ?? '').trim()
    const parentItemId = String(item.parent_item_id ?? '').trim()
    const isCondo = item.is_detail_row === true
      || !!parentItemId
      || isCondoStampCategory(productCategoryByProductId[productId])
      || isCondoStampProductName(item.product_name)

    if (!isCondo) continue
    if (itemId) itemIds.add(itemId)
    if (parentItemId) itemIds.add(parentItemId)
    if (productId) productIds.add(productId)
  }

  // แถวหลักและแถวรายละเอียดของสินค้าคอนโดใช้ product_id เดียวกัน
  for (const item of items) {
    const itemId = String(item.id ?? '').trim()
    const productId = String(item.product_id ?? '').trim()
    if (productId && productIds.has(productId) && itemId) itemIds.add(itemId)
  }

  return { itemIds, productIds }
}

export function isCondoStampItem(
  item: CondoStampItemLike,
  identity: CondoStampItemIdentity,
  productCategory?: string | null,
): boolean {
  const itemId = String(item.id ?? '').trim()
  const productId = String(item.product_id ?? '').trim()
  return (itemId !== '' && identity.itemIds.has(itemId))
    || (productId !== '' && identity.productIds.has(productId))
    || isCondoStampCategory(productCategory)
    || isCondoStampProductName(item.product_name)
}
