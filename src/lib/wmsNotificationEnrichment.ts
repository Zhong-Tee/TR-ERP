import type { SupabaseClient } from '@supabase/supabase-js'

/** แจ้งเตือน "ยกเลิกบิล" หลายแถวต่อใบงาน → แสดง/นับเป็น 1 รายการต่อ order_id (ลำดับเดิมของแถวแรกที่เจอ) */
export function dedupeWmsNotificationsForDisplay<T extends { type?: string; order_id?: string }>(data: T[]): T[] {
  const seenCancelledOrder = new Set<string>()
  return data.filter((n: any) => {
    if (n.type !== 'ยกเลิกบิล') return true
    const key = String(n.order_id || '')
    if (seenCancelledOrder.has(key)) return false
    seenCancelledOrder.add(key)
    return true
  })
}

/**
 * รวมแจ้งเตือนประเภท "ยกเลิกบิล" ต่อใบงาน (order_id) และคำนวณข้อความสินค้า/จุดจัดเก็บให้ตรงกับศูนย์แจ้งเตือน (เดสก์ท็อป)
 */
export async function enrichWmsNotificationsWithOrderDetails(
  supabase: SupabaseClient,
  data: any[],
): Promise<any[]> {
  if (!data.length) return []

  const oids = [...new Set(data.map((n: any) => n.order_id))]
  const { data: oDetails } = await supabase
    .from('wms_orders')
    .select('id, order_id, product_code, product_name, location, status, stock_action')
    .in('order_id', oids)

  const { data: cancelledOrders } = await supabase
    .from('or_orders')
    .select('id, bill_no, customer_name, work_order_name, created_at')
    .in('work_order_name', oids)
    .eq('status', 'ยกเลิก')
    .order('created_at', { ascending: false })

  const cancelledOrderIds = [...new Set((cancelledOrders || []).map((o: any) => o.id).filter(Boolean))]
  let orderCodeSetMap = new Map<string, Set<string>>()
  let orderItemCountMap = new Map<string, number>()
  if (cancelledOrderIds.length > 0) {
    const { data: orderItems } = await supabase
      .from('or_order_items')
      .select('order_id, product_id')
      .in('order_id', cancelledOrderIds)
    orderItemCountMap = (orderItems || []).reduce((acc: Map<string, number>, item: any) => {
      const orderId = String(item.order_id || '')
      if (!orderId) return acc
      acc.set(orderId, (acc.get(orderId) || 0) + 1)
      return acc
    }, new Map<string, number>())
    const productIds = [...new Set((orderItems || []).map((i: any) => i.product_id).filter(Boolean))]
    const { data: products } = productIds.length
      ? await supabase.from('pr_products').select('id, product_code').in('id', productIds)
      : { data: [] as any[] }
    const codeByProductId = new Map<string, string>()
    for (const p of products || []) {
      codeByProductId.set(String(p.id), String(p.product_code || '').trim().toUpperCase())
    }
    orderCodeSetMap = (orderItems || []).reduce((acc: Map<string, Set<string>>, item: any) => {
      const orderId = String(item.order_id || '')
      if (!orderId) return acc
      const code = codeByProductId.get(String(item.product_id || '')) || ''
      if (!code) return acc
      if (!acc.has(orderId)) acc.set(orderId, new Set<string>())
      acc.get(orderId)!.add(code)
      return acc
    }, new Map<string, Set<string>>())
  }

  const cancelledByWorkOrder = (cancelledOrders || []).reduce(
    (acc: Record<string, { id: string; bill_no: string; customer_name: string }[]>, row: any) => {
      const key = String(row.work_order_name || '')
      if (!key) return acc
      if (!acc[key]) acc[key] = []
      acc[key].push({ id: row.id, bill_no: row.bill_no || '-', customer_name: row.customer_name || '-' })
      return acc
    },
    {},
  )

  const normalizedRows = dedupeWmsNotificationsForDisplay(data)

  return normalizedRows.map((n: any) => {
    const rows = (oDetails || []).filter((o: any) => o.order_id === n.order_id)
    const cancelledRows = rows.filter((o: any) => o.status === 'cancelled')
    const cancelledOrdersForRow = cancelledByWorkOrder[String(n.order_id || '')] || []
    const primaryCancelledOrderId = cancelledOrdersForRow[0]?.id
    const primaryOrderItemCount = primaryCancelledOrderId
      ? orderItemCountMap.get(String(primaryCancelledOrderId)) || 0
      : 0
    const primaryCodeSet = primaryCancelledOrderId ? orderCodeSetMap.get(String(primaryCancelledOrderId)) : undefined
    const filteredCancelledRows =
      n.type === 'ยกเลิกบิล' && primaryCodeSet && primaryCodeSet.size > 0
        ? cancelledRows.filter((o: any) => primaryCodeSet.has(String(o.product_code || '').trim().toUpperCase()))
        : cancelledRows
    const pendingCancelled = filteredCancelledRows.filter((o: any) => o.stock_action == null).length
    const first = rows[0] || { product_name: '---', location: '---' }
    const productName =
      n.type === 'ยกเลิกบิล'
        ? primaryOrderItemCount > 0
          ? `รวม ${primaryOrderItemCount} รายการ`
          : filteredCancelledRows.length > 0
            ? `รวม ${filteredCancelledRows.length} รายการ`
            : 'บิลยกเลิก'
        : first.product_name
    const location = n.type === 'ยกเลิกบิล' ? '-' : first.location
    return {
      ...n,
      product_name: productName,
      location,
      pendingCancelled,
      cancelled_orders: cancelledOrdersForRow,
    }
  })
}
