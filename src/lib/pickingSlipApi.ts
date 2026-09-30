import { supabase } from './supabase'
import { fetchAllSupabasePages } from './supabasePagination'
import { isPhysicalOrderItem } from './condoStamp'
import { isOrderItemAllowedInFulfillmentFlow } from './orderFlowFilter'
import { pickingDestination } from './pickingSlipData'
import { resolvePickingSlipStatus, type PickingSlipStatus } from './pickingSlipStatus'

export async function fetchPickingRouting(productIds: string[]) {
  const categories = await fetchAllSupabasePages<{ category_name: string }>((from, to) => supabase
    .from('wms_non_picker_categories').select('category_name').order('id').range(from, to))
  const warehouses = new Map<string, string[]>()
  for (let offset = 0; offset < productIds.length; offset += 200) {
    const links = await fetchAllSupabasePages<{ product_id: string; warehouse: { name: string; is_active: boolean } }>((from, to) => supabase
      .from('wh_sub_warehouse_products')
      .select('product_id, warehouse:wh_sub_warehouses!inner(name, is_active)')
      .in('product_id', productIds.slice(offset, offset + 200)).eq('warehouse.is_active', true)
      .order('id').range(from, to).returns<{ product_id: string; warehouse: { name: string; is_active: boolean } }[]>())
    for (const link of links) {
      warehouses.set(link.product_id, [...new Set([...(warehouses.get(link.product_id) ?? []), link.warehouse.name])].sort())
    }
  }
  return { warehouses, excluded: new Set(categories.map((c) => c.category_name.trim().toUpperCase())) }
}

export async function fetchPickingSlipStatuses(workOrderIds: string[]): Promise<Record<string, PickingSlipStatus>> {
  if (!workOrderIds.length) return {}
  type Item = {
    product_id: string; product_name: string; product_type: string | null
    is_detail_row: boolean | null; parent_item_id: string | null; cancellation_stock_action: string | null
    order: { work_order_id: string; status: string }
    product: { product_category: string | null; rubber_code: string | null } | null
  }
  const items: Item[] = []
  const printedIds = new Set<string>()
  for (let offset = 0; offset < workOrderIds.length; offset += 100) {
    const ids = workOrderIds.slice(offset, offset + 100)
    const [batch, prints] = await Promise.all([
      fetchAllSupabasePages<Item>((from, to) => supabase.from('or_order_items')
        .select('product_id, product_name, product_type, is_detail_row, parent_item_id, cancellation_stock_action, order:or_orders!inner(work_order_id, status), product:pr_products(product_category, rubber_code)')
        .in('order.work_order_id', ids).neq('order.status', 'ยกเลิก')
        .order('id').range(from, to).returns<Item[]>()),
      supabase.from('or_work_order_picking_slip_prints').select('work_order_id').in('work_order_id', ids),
    ])
    if (prints.error) throw prints.error
    items.push(...batch)
    prints.data?.forEach((row) => printedIds.add(row.work_order_id))
  }
  const routing = await fetchPickingRouting([...new Set(items.map((item) => item.product_id).filter(Boolean))])
  const hasPicking = new Set<string>()
  for (const item of items) {
    const category = item.product?.product_category ?? ''
    if (!isOrderItemAllowedInFulfillmentFlow(item.cancellation_stock_action) ||
      !isPhysicalOrderItem({ ...item, product_category: category })) continue
    const destination = pickingDestination(category, routing.warehouses.get(item.product_id) ?? [], routing.excluded)
    if (destination === 'main' || item.product?.rubber_code?.trim()) hasPicking.add(item.order.work_order_id)
  }
  return Object.fromEntries(workOrderIds.map((id) => [id, resolvePickingSlipStatus(hasPicking.has(id), printedIds.has(id))]))
}

export async function recordPickingSlipPrint(workOrderId: string) {
  const { error } = await supabase.from('or_work_order_picking_slip_prints')
    .upsert({ work_order_id: workOrderId }, { onConflict: 'work_order_id', ignoreDuplicates: true })
  if (error) throw error
}

