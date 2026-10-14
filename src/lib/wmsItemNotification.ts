import { getWmsConsolidatedRowIds } from './wmsCondoStampConsolidation'

/** Keep a product snapshot as well as the exact WMS row for later display. */
export function wmsItemNotificationPayload(item: {
  id: string; order_id: string; product_code: string; product_name: string
  location?: string | null; _consolidated_wms_ids?: string[]
}, pickerId: string, type: string) {
  return {
    type,
    order_id: item.order_id,
    wms_order_id: getWmsConsolidatedRowIds(item)[0],
    product_code: item.product_code,
    product_name: item.product_name,
    location: item.location || null,
    picker_id: pickerId,
    status: 'unread',
    is_read: false,
  }
}
