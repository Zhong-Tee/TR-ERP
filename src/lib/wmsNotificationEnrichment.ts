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
  const [{ data: oDetails }, { data: candidateOrders }, { data: workOrders }] = await Promise.all([
    supabase
      .from('wms_orders')
      .select('id, work_order_id, order_id, source_order_id, product_code, product_name, location, status, stock_action, stock_action_at, returned_to_shelf_at, stock_action_user:us_users!stock_action_by(username), shelf_return_user:us_users!returned_to_shelf_by(username)')
      .in('order_id', oids),
    supabase
      .from('or_orders')
      .select('id, bill_no, customer_name, work_order_name, created_at')
      .in('work_order_name', oids)
      .order('created_at', { ascending: false }),
    supabase
      .from('or_work_orders')
      .select('id, work_order_name, cancellation_state')
      .in('work_order_name', oids),
  ])

  const workOrderByName = new Map((workOrders || []).map((row: any) => [String(row.work_order_name || ''), row]))

  const candidateOrderIds = (candidateOrders || []).map((row: any) => row.id).filter(Boolean)
  const { data: cancelledItemRows } = candidateOrderIds.length
    ? await supabase
        .from('or_order_items')
        .select('order_id')
        .in('order_id', candidateOrderIds)
        .not('cancellation_stock_action', 'is', null)
    : { data: [] as any[] }
  const cancellationOrderIds = new Set((cancelledItemRows || []).map((r: any) => r.order_id).filter(Boolean))
  const cancelledOrders = (candidateOrders || []).filter((row: any) => cancellationOrderIds.has(row.id))

  const cancelledOrderIds = [...new Set((cancelledOrders || []).map((o: any) => o.id).filter(Boolean))]
  let orderCodeSetMap = new Map<string, Set<string>>()
  let orderItemCountMap = new Map<string, number>()
  if (cancelledOrderIds.length > 0) {
    const { data: orderItems } = await supabase
      .from('or_order_items')
      .select('order_id, product_id')
      .in('order_id', cancelledOrderIds)
      .not('cancellation_stock_action', 'is', null)
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
    const cancelledRows = rows.filter((o: any) =>
      o.status === 'cancelled' || o.stock_action === 'recalled' || o.stock_action === 'waste'
    )
    const cancelledOrdersForRow = cancelledByWorkOrder[String(n.order_id || '')] || []
    const cancelledOrderIdSet = new Set(cancelledOrdersForRow.map((order) => String(order.id)))
    const cancelledCodeSet = new Set<string>()
    let cancelledOrderItemCount = 0
    cancelledOrderIdSet.forEach((orderId) => {
      cancelledOrderItemCount += orderItemCountMap.get(orderId) || 0
      orderCodeSetMap.get(orderId)?.forEach((code) => cancelledCodeSet.add(code))
    })
    const filteredCancelledRows =
      n.type === 'ยกเลิกบิล' && cancelledOrderIdSet.size > 0
        ? cancelledRows.filter((o: any) =>
            o.source_order_id
              ? cancelledOrderIdSet.has(String(o.source_order_id))
              : cancelledCodeSet.has(String(o.product_code || '').trim().toUpperCase())
          )
        : cancelledRows
    const pendingCancelled = filteredCancelledRows.filter((o: any) => o.stock_action == null).length
    const awaitingShelf = filteredCancelledRows.filter((o: any) => o.stock_action === 'recalled' && o.status !== 'returned').length
    const returnedToShelf = filteredCancelledRows.filter((o: any) => o.stock_action === 'recalled' && o.status === 'returned').length
    const wasteCount = filteredCancelledRows.filter((o: any) => o.stock_action === 'waste').length
    const uniqueNames = (values: unknown[]) => [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
    const awaitingShelfActors = uniqueNames(filteredCancelledRows
      .filter((o: any) => o.stock_action === 'recalled' && o.status !== 'returned')
      .map((o: any) => o.stock_action_user?.username))
    const returnedToShelfActors = uniqueNames(filteredCancelledRows
      .filter((o: any) => o.stock_action === 'recalled' && o.status === 'returned')
      .map((o: any) => o.shelf_return_user?.username || o.stock_action_user?.username))
    const wasteActors = uniqueNames(filteredCancelledRows
      .filter((o: any) => o.stock_action === 'waste')
      .map((o: any) => o.stock_action_user?.username))
    const first = rows[0] || { product_name: '---', location: '---' }
    const productName =
      n.type === 'ยกเลิกบิล'
        ? cancelledOrderItemCount > 0
          ? `รวม ${cancelledOrderItemCount} รายการ`
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
      awaitingShelf,
      returnedToShelf,
      wasteCount,
      awaitingShelfActors,
      returnedToShelfActors,
      wasteActors,
      work_order_id: workOrderByName.get(String(n.order_id || ''))?.id || rows[0]?.work_order_id || null,
      cancellation_state: workOrderByName.get(String(n.order_id || ''))?.cancellation_state || null,
      cancelled_orders: cancelledOrdersForRow,
    }
  })
}
