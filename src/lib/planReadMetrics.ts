export type PlanWorkOrderMetrics = Record<string, {
  bill_count: number
  category_qty: Record<string, number>
}>

export function planWorkOrderIdsKey(jobs: Array<{ work_order_id?: string | null }>) {
  return JSON.stringify([...new Set(jobs.map(job => job.work_order_id).filter((id): id is string => !!id))].sort())
}

export function planQuantityMaps(metrics: PlanWorkOrderMetrics, departments: Record<string, string[]>) {
  const bills: Record<string, number> = {}
  const categories: Record<string, Record<string, number>> = {}
  const quantities: Record<string, Record<string, number>> = {}
  const selected = Object.entries(departments).filter(([, values]) => Array.isArray(values) && values.length > 0)
  for (const [id, metric] of Object.entries(metrics)) {
    bills[id] = Number(metric.bill_count)
    if (!selected.length) continue // Preserve the no-category-configuration behavior.
    categories[id] = metric.category_qty
    quantities[id] = Object.fromEntries(selected.map(([dept, values]) => [dept,
      values.reduce((sum, category) => sum + Number(metric.category_qty[category] || 0), 0),
    ]))
  }
  return { bills, categories, quantities }
}

/** Skip metadata-only changes only when both row versions are actually available. */
export function planMetricsEventAffects(table: string, event: {
  eventType: string; old: Record<string, unknown>; new: Record<string, unknown>
}, ids: readonly string[]) {
  const fields: Record<string, string[]> = {
    or_orders: ['id', 'work_order_id', 'status'],
    or_order_items: ['id', 'order_id', 'product_id', 'quantity'],
    pr_products: ['id', 'product_category', 'is_active'],
  }
  const keys = fields[table]
  if (event.eventType === 'UPDATE' && keys?.every(key => key in event.old && key in event.new)
    && keys.every(key => event.old[key] === event.new[key])) return false
  if (table === 'or_orders') {
    const versions = event.eventType === 'INSERT' ? [event.new]
      : event.eventType === 'DELETE' ? [event.old] : [event.old, event.new]
    if (versions.every(row => 'work_order_id' in row)
      && versions.every(row => !ids.includes(String(row.work_order_id || '')))) return false
  }
  return true
}

export function planHistoryEventAffects(kind: 'cancelled' | 'released', table: string, event: {
  eventType: string; old: Record<string, unknown>; new: Record<string, unknown>
}) {
  const fields = table === 'or_order_items' ? ['id', 'order_id', 'cancellation_stock_action']
    : kind === 'cancelled'
      ? ['id', 'work_order_id', 'status', 'bill_no', 'channel_order_no', 'customer_name']
      : ['id', 'status', 'plan_released_from_work_order_id', 'plan_released_from_work_order', 'bill_no', 'customer_name']
  return event.eventType !== 'UPDATE'
    || !fields.every(key => key in event.old && key in event.new && event.old[key] === event.new[key])
}
