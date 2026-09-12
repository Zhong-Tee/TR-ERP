export type ClaimRevisionItem = {
  id?: string
  edit_key?: string
  product_id?: string | null
  product_name?: string | null
  quantity?: number | null
  unit_price?: number | null
  is_free?: boolean | null
}

export function buildClaimRevisionSnapshot<T extends ClaimRevisionItem>(
  sourceItems: T[],
  sourceShipping: number,
  sourceDiscount: number,
) {
  const items = sourceItems.map(({ edit_key: _editKey, id: _id, ...item }) => ({
    ...item,
    product_id: item.product_id || null,
    product_name: String(item.product_name || '').trim(),
    quantity: Number(item.quantity) || 1,
    unit_price: Number(item.unit_price) || 0,
  }))
  const price = items.reduce(
    (sum, item) => sum + (item.is_free ? 0 : (Number(item.quantity) || 0) * (Number(item.unit_price) || 0)),
    0,
  )
  const shippingCost = Number(sourceShipping) || 0
  const discount = Number(sourceDiscount) || 0
  return {
    order: {
      price,
      shipping_cost: shippingCost,
      discount,
      total_amount: price + shippingCost - discount,
    },
    items,
  }
}

export function claimRevisionFingerprint<T extends ClaimRevisionItem>(
  sourceItems: T[],
  sourceShipping: number,
  sourceDiscount: number,
) {
  return JSON.stringify(buildClaimRevisionSnapshot(sourceItems, sourceShipping, sourceDiscount))
}

export function failedClaimEditAction(input: {
  billChanged: boolean
  newSlipCount: number
}): 'submit_reapproval' | 'verify_slip' | 'none' {
  if (input.billChanged) return 'submit_reapproval'
  if (input.newSlipCount > 0) return 'verify_slip'
  return 'none'
}
