import { supabase } from './supabase'

const WMS_HISTORY_SELECT =
  'id, work_order_id, order_id, source_order_id, source_order_item_id, product_code, product_name, location, qty, status, stock_action, assigned_to, created_at, end_time, us_users!assigned_to(username)'

/**
 * โหลดประวัติ WMS ของรายการยกเลิกให้รองรับทั้งข้อมูลใหม่และ legacy:
 * - ข้อมูลใหม่ผูกด้วย work_order_id/source_order_id/source_order_item_id
 * - ข้อมูลเก่าผูกด้วยชื่อใบงานใน order_id และอาจไม่มี source ids
 * - หลังนำกลับเข้าชั้น status อาจเป็น returned แต่ stock_action ยังคงเป็น recalled
 */
export async function fetchCancelledWmsHistory(params: {
  workOrderId: string
  workOrderName?: string | null
  orderId: string
}): Promise<any[]> {
  const { workOrderId, workOrderName, orderId } = params

  const [{ data: orderRow, error: orderError }, { data: allOrderItems, error: itemError }] = await Promise.all([
    supabase.from('or_orders').select('status').eq('id', orderId).maybeSingle(),
    supabase
      .from('or_order_items')
      .select('id, product_id, cancellation_stock_action')
      .eq('order_id', orderId),
  ])
  if (orderError) throw orderError
  if (itemError) throw itemError

  const isFullCancellation = String(orderRow?.status || '') === 'ยกเลิก'
  const cancelledItems = isFullCancellation
    ? allOrderItems || []
    : (allOrderItems || []).filter((row: any) => String(row.cancellation_stock_action || '').trim() !== '')

  const itemIds = (cancelledItems || []).map((row: any) => String(row.id || '')).filter(Boolean)
  const itemIdSet = new Set(itemIds)
  const productIds = [...new Set((cancelledItems || []).map((row: any) => row.product_id).filter(Boolean))]
  const { data: products, error: productError } = productIds.length
    ? await supabase.from('pr_products').select('id, product_code').in('id', productIds)
    : { data: [] as any[], error: null }
  if (productError) throw productError
  const productCodes = new Set(
    (products || []).map((p: any) => String(p.product_code || '').trim().toUpperCase()).filter(Boolean)
  )

  const historyStatusFilter = 'status.eq.cancelled,stock_action.in.(recalled,waste)'
  const requests: any[] = [
    supabase
      .from('wms_orders')
      .select(WMS_HISTORY_SELECT)
      .eq('work_order_id', workOrderId)
      .or(historyStatusFilter),
  ]
  const legacyName = String(workOrderName || '').trim()
  if (legacyName) {
    requests.push(
      supabase
        .from('wms_orders')
        .select(WMS_HISTORY_SELECT)
        .eq('order_id', legacyName)
        .or(historyStatusFilter)
    )
  }

  const results = await Promise.all(requests)
  const byId = new Map<string, any>()
  for (const result of results) {
    if (result.error) throw result.error
    for (const row of result.data || []) byId.set(String(row.id), row)
  }

  return [...byId.values()]
    .filter((row: any) => {
      if (row.source_order_item_id) return itemIdSet.has(String(row.source_order_item_id))
      if (row.source_order_id) return String(row.source_order_id) === orderId
      // Legacy ไม่มี source ids: ใช้รหัสสินค้าเฉพาะรายการที่ถูกยกเลิกเป็น fallback
      return productCodes.has(String(row.product_code || '').trim().toUpperCase())
    })
    .sort((a: any, b: any) => {
      const ta = new Date(a.created_at || 0).getTime()
      const tb = new Date(b.created_at || 0).getTime()
      if (ta !== tb) return ta - tb
      return String(a.id).localeCompare(String(b.id))
    })
}
