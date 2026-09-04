export type PriceableOrderItem = {
  quantity?: number | null
  unit_price?: number | null
  is_free?: boolean | null
  is_detail_row?: boolean | null
  parent_item_id?: string | null
  product_name?: string | null
  product_type?: string | null
}

/** รองรับข้อมูลคอนโดเก่าที่อาจยังไม่มี is_detail_row/parent_item_id */
export function isCondoPriceDetailRow(item: PriceableOrderItem): boolean {
  if (item.is_detail_row === true || String(item.parent_item_id || '').trim()) return true
  const isLegacyCondo = String(item.product_name || '').trim().startsWith('ตรายางคอนโด')
  return isLegacyCondo && String(item.product_type || 'ชั้น1').trim() !== 'ชั้น1'
}

/** รวมราคาเฉพาะแถวสินค้าหลัก แถวรายละเอียดชั้นและของแถมไม่สร้างมูลค่าเพิ่ม */
export function calculateChargeableItemsTotal<T extends PriceableOrderItem>(
  items: T[],
  isDetailRow: (item: T) => boolean = isCondoPriceDetailRow,
): number {
  return items.reduce((sum, item) => {
    if (item.is_free || isDetailRow(item)) return sum
    const quantity = Number(item.quantity) || 1
    const unitPrice = Number(item.unit_price) || 0
    return sum + quantity * unitPrice
  }, 0)
}
