export const TUBE_GIFT_PRODUCT_CODE = '110000025'
export const TUBE_GIFT_PRODUCT_NAME = 'เชือกคละสี 10 เส้น'

type AutoGiftItem = {
  product_id?: string | null
  product_name?: string | null
  quantity?: number | null
  unit_price?: number | null
  is_free?: boolean
  is_detail_row?: boolean
  parent_item_id?: string | null
  product_type?: string | null
}

type AutoGiftProduct = {
  id: string
  product_code?: string | null
  product_name?: string | null
  product_category?: string | null
}

function normalize(value: string | null | undefined): string {
  return String(value || '').trim().toUpperCase()
}

export function findTubeGiftProduct<T extends AutoGiftProduct>(products: T[]): T | undefined {
  return products.find((product) => normalize(product.product_code) === TUBE_GIFT_PRODUCT_CODE)
}

export function isTubeAutoGiftItem(
  item: AutoGiftItem,
  products: AutoGiftProduct[],
): boolean {
  if (!item.is_free) return false

  const product = products.find((candidate) => String(candidate.id) === String(item.product_id || ''))
  if (normalize(product?.product_code) === TUBE_GIFT_PRODUCT_CODE) return true

  // รองรับบิลเก่าหรือช่วงที่ข้อมูลสินค้าเพิ่งโหลด โดยใช้ชื่อเป็น fallback เท่านั้น
  return String(item.product_name || '').trim() === TUBE_GIFT_PRODUCT_NAME
}

export function getTubeEligibleQuantity(
  items: AutoGiftItem[],
  products: AutoGiftProduct[],
): number {
  const productById = new Map(products.map((product) => [String(product.id), product]))

  return items.reduce((total, item) => {
    if (item.is_free || item.is_detail_row) return total
    const product = productById.get(String(item.product_id || ''))
    if (normalize(product?.product_category) !== 'TUBE') return total

    const quantity = Number(item.quantity || 0)
    return Number.isFinite(quantity) && quantity > 0 ? total + quantity : total
  }, 0)
}

/**
 * ทำให้ทั้งบิลมีของแถม TUBE เพียงหนึ่งบรรทัด และจำนวนเท่ากับยอดรวมสินค้า TUBE
 * คืน array เดิมเมื่อข้อมูลถูกต้องอยู่แล้ว เพื่อให้ React ไม่ render วนซ้ำ
 */
export function reconcileTubeGiftItems<T extends AutoGiftItem>(
  items: T[],
  products: AutoGiftProduct[],
): T[] {
  const requiredQuantity = getTubeEligibleQuantity(items, products)
  const giftProduct = findTubeGiftProduct(products)
  const giftIndexes = items.reduce<number[]>((indexes, item, index) => {
    if (isTubeAutoGiftItem(item, products)) indexes.push(index)
    return indexes
  }, [])

  if (requiredQuantity <= 0) {
    if (giftIndexes.length === 0) return items
    const indexesToRemove = new Set(giftIndexes)
    return items.filter((_, index) => !indexesToRemove.has(index))
  }

  // ผู้เรียกต้องแจ้งผู้ใช้ว่ารหัสของแถมหาย/ถูกปิดใช้งาน ไม่สร้างแถวที่ไม่มี product_id
  if (!giftProduct) return items

  const firstGiftIndex = giftIndexes[0]
  if (firstGiftIndex == null) {
    return [
      ...items,
      {
        product_id: giftProduct.id,
        product_name: giftProduct.product_name || TUBE_GIFT_PRODUCT_NAME,
        product_type: 'ชั้น1',
        quantity: requiredQuantity,
        unit_price: 0,
        is_free: true,
        is_detail_row: false,
        parent_item_id: null,
      } as T,
    ]
  }

  const existingGift = items[firstGiftIndex]
  const expectedName = giftProduct.product_name || TUBE_GIFT_PRODUCT_NAME
  const giftIsCorrect =
    giftIndexes.length === 1 &&
    String(existingGift.product_id || '') === String(giftProduct.id) &&
    String(existingGift.product_name || '') === expectedName &&
    Number(existingGift.quantity || 0) === requiredQuantity &&
    Number(existingGift.unit_price || 0) === 0 &&
    existingGift.is_free === true &&
    existingGift.is_detail_row !== true &&
    existingGift.parent_item_id == null

  if (giftIsCorrect) return items

  const duplicateIndexes = new Set(giftIndexes.slice(1))
  return items
    .filter((_, index) => !duplicateIndexes.has(index))
    .map((item, index) => {
      if (index !== firstGiftIndex) return item
      return {
        ...item,
        product_id: giftProduct.id,
        product_name: expectedName,
        product_type: item.product_type || 'ชั้น1',
        quantity: requiredQuantity,
        unit_price: 0,
        is_free: true,
        is_detail_row: false,
        parent_item_id: null,
      }
    })
}
