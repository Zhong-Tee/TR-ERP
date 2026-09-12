export const FULFILLMENT_EXCLUDED_ORDER_STATUSES = ['ยกเลิก'] as const

export type FulfillmentExcludedOrderStatus = (typeof FULFILLMENT_EXCLUDED_ORDER_STATUSES)[number]

export const FULFILLMENT_EXCLUDED_ORDER_STATUSES_IN = `(${FULFILLMENT_EXCLUDED_ORDER_STATUSES.map((s) => `"${s}"`).join(',')})`

export function isOrderAllowedInFulfillmentFlow(status: string | null | undefined): boolean {
  if (!status) return true
  return !FULFILLMENT_EXCLUDED_ORDER_STATUSES.includes(status as FulfillmentExcludedOrderStatus)
}

/**
 * รายการที่ถูกยกเลิกยังต้องคงอยู่ใน or_order_items เพื่อประวัติ/Audit
 * แต่ห้ามนำกลับเข้าสายงาน Plan → Picker → QC → Packing อีก
 */
export function isOrderItemAllowedInFulfillmentFlow(
  cancellationStockAction: string | null | undefined
): boolean {
  return !String(cancellationStockAction || '').trim()
}
