import { supabase } from './supabase'
import { operationalCountCache } from './readRefresh'
import { fetchWorkOrdersWithProgress } from './qcApi'
import { loadPurchaseBadgeCounts } from './purchaseApi'
import { loadWmsTabCounts } from '../components/wms/wmsUtils'
import { isAdminOrSuperadmin, resolveOwnerScopeAdminName } from '../config/accessPolicy'
import { PLAN_WORK_QUEUE_POSTGREST_FILTER } from './planWorkQueue'
import { loadHrPendingCounts, loadPendingReturns } from './operationalBadges'

export const SIDEBAR_COUNT_GROUPS = ['core', 'orders', 'account', 'qc', 'wms', 'returns', 'purchase', 'plan', 'machinery', 'hr', 'marketplace'] as const
export type SidebarCountGroup = typeof SIDEBAR_COUNT_GROUPS[number]
export type SidebarCountContext = {
  scope: string; role: string; username?: string | null; email?: string | null; allowed: string[]
}
export type SidebarCountPatch = {
  counts?: Record<string, number>
  machinery?: { warning: number; critical: number }
  purchase?: Awaited<ReturnType<typeof loadPurchaseBadgeCounts>>
  warehouse?: number
  returns?: number
}

const keyFor = (context: SidebarCountContext, group: string) =>
  `sidebar:${context.scope}:${JSON.stringify(context.allowed)}:${group}`

export function invalidateSidebarCounts(context: SidebarCountContext, groups: readonly SidebarCountGroup[]) {
  for (const group of groups) operationalCountCache.invalidate(keyFor(context, group))
  if (groups.some(group => ['core', 'orders', 'account', 'qc'].includes(group))) {
    operationalCountCache.invalidate(`sidebar-base:${context.scope}`)
  }
  if (groups.includes('wms')) operationalCountCache.invalidate(`wms:${context.scope}`)
  if (groups.includes('qc')) operationalCountCache.invalidate(`qc-progress:${context.scope}:true`)
  if (groups.includes('hr')) operationalCountCache.invalidate(`hr:${context.scope}`)
  if (groups.includes('returns')) operationalCountCache.invalidate(`returns:${context.scope}`)
}

/** Dependencies affect only their badge groups; role/menu changes use a different cache key. */
export function sidebarGroupsForTable(table: string): SidebarCountGroup[] {
  const groups: Record<string, SidebarCountGroup[]> = {
    mp_orders: ['marketplace'],
    or_orders: ['core', 'orders', 'account', 'qc', 'wms', 'plan'],
    or_order_items: ['core', 'qc', 'wms'],
    or_work_orders: ['core', 'qc', 'wms', 'plan'],
    plan_jobs: ['qc'],
    qc_records: ['core', 'qc'], qc_sessions: ['qc'], qc_skip_logs: ['qc'],
    wms_orders: ['wms'], wms_requisitions: ['wms'], wms_notifications: ['wms'],
    wms_return_requisitions: ['wms'], wms_borrow_requisitions: ['wms'],
    wms_non_picker_categories: ['wms'], wh_sub_warehouses: ['wms'], wh_sub_warehouse_products: ['wms'],
    pr_products: ['core', 'qc', 'wms'], inv_stock_balances: ['core', 'wms'], inv_stock_movements: ['wms'],
    ac_refunds: ['account'], ac_overpayment_waivers: ['account'],
    ac_manual_slip_checks: ['account'], or_order_amendments: ['account'], or_claim_requests: ['account', 'orders'],
    inv_returns: ['returns'], inv_pr: ['purchase', 'core'], inv_po: ['purchase', 'core'], inv_po_items: ['core'],
    pr_machinery_machines: ['machinery'],
    hr_leave_requests: ['hr'], hr_ot_requests: ['hr'], hr_wfh_requests: ['hr'],
  }
  return groups[table] || []
}

export const SIDEBAR_COUNT_TABLES = [
  'mp_orders', 'or_orders', 'or_order_items', 'or_work_orders',
  'qc_records', 'qc_sessions', 'qc_skip_logs', 'wms_orders', 'wms_requisitions',
  'wms_notifications', 'wms_return_requisitions', 'wms_borrow_requisitions',
  'wms_non_picker_categories', 'wh_sub_warehouses', 'wh_sub_warehouse_products',
  'pr_products', 'inv_stock_balances', 'inv_stock_movements',
  'ac_refunds', 'ac_overpayment_waivers', 'ac_manual_slip_checks',
  'or_order_amendments', 'or_claim_requests', 'inv_returns', 'inv_pr', 'inv_po', 'inv_po_items',
  'pr_machinery_machines', 'hr_leave_requests', 'hr_ot_requests', 'hr_wfh_requests',
]

export function sidebarEnabledGroups(context: SidebarCountContext): SidebarCountGroup[] {
  const allowed = (menu: string) => context.allowed.includes(menu)
  const enabled: Record<SidebarCountGroup, boolean> = {
    core: ['admin-qc', 'packing', 'warehouse'].some(allowed), orders: allowed('orders'),
    account: allowed('account'), qc: allowed('qc'), wms: allowed('wms'),
    returns: allowed('warehouse'), purchase: allowed('purchase'), plan: allowed('plan'),
    machinery: allowed('machinery'), hr: allowed('hr'), marketplace: allowed('marketplace'),
  }
  return SIDEBAR_COUNT_GROUPS.filter(group => enabled[group])
}

export function sidebarGroupsForContextTable(context: SidebarCountContext, table: string) {
  const enabled = sidebarEnabledGroups(context)
  const coreTables = new Set<string>()
  if (context.allowed.includes('packing')) coreTables.add('or_work_orders')
  if (context.allowed.includes('admin-qc')) coreTables.add('or_orders')
  if (context.allowed.includes('warehouse')) {
    for (const name of ['or_orders', 'or_order_items', 'pr_products', 'inv_stock_balances', 'inv_po', 'inv_po_items']) coreTables.add(name)
  }
  return sidebarGroupsForTable(table).filter(group => enabled.includes(group) && (group !== 'core' || coreTables.has(table)))
}

export function sidebarGroupsForEvent(context: SidebarCountContext, table: string, event: {
  eventType: string; old: Record<string, unknown>; new: Record<string, unknown>
}) {
  const groups = sidebarGroupsForContextTable(context, table)
  if (table !== 'or_orders' || event.eventType !== 'UPDATE') return groups
  // or_orders uses REPLICA IDENTITY FULL. If an old row is incomplete, refresh
  // conservatively; otherwise parcel metadata alone must not refetch every badge.
  const fields: Partial<Record<SidebarCountGroup, string[]>> = {
    core: ['id', 'status', 'channel_code', 'admin_user', 'entry_date'],
    orders: ['id', 'status', 'claim_type', 'claim_shipping_confirmed_at', 'failed_queue_archived_at', 'admin_user'],
    account: ['id', 'status', 'admin_user', 'billing_details'],
    qc: ['id', 'work_order_id', 'work_order_name', 'status', 'bill_no'],
    wms: ['id', 'work_order_id', 'work_order_name', 'status', 'entry_date'],
    plan: ['id', 'status', 'work_order_id', 'channel_code'],
  }
  return groups.filter(group => !fields[group]?.every(key => key in event.old && key in event.new
    && JSON.stringify(event.old[key]) === JSON.stringify(event.new[key])))
}

export async function readSidebarCounts(context: SidebarCountContext, requested: readonly SidebarCountGroup[]) {
  const allowed = (menu: string) => context.allowed.includes(menu)
  const enabled = sidebarEnabledGroups(context)
  const adminName = resolveOwnerScopeAdminName(context.role, context.username, context.email)
  async function base() {
    return operationalCountCache.read(`sidebar-base:${context.scope}`, async () => {
      const { data, error } = await supabase.rpc('get_sidebar_counts', { p_username: adminName, p_role: context.role })
      if (error) throw error
      return (data || {}) as Record<string, number>
    })
  }
  async function count(query: PromiseLike<{ count: number | null; error: unknown }>) {
    const result = await query
    if (result.error) throw result.error
    return result.count || 0
  }
  async function load(group: SidebarCountGroup): Promise<SidebarCountPatch> {
    switch (group) {
      case 'core': {
        if (!allowed('admin-qc') && !allowed('warehouse')) {
          return { counts: { packing: await count(supabase.from('or_work_orders')
            .select('id', { count: 'exact', head: true }).eq('status', 'กำลังผลิต')) } }
        }
        const c = await base()
        return {
          counts: Object.fromEntries([
            ['admin-qc', c.admin_qc || 0], ['packing', c.packing || 0], ['warehouse', c.warehouse || 0],
          ].filter(([menu]) => allowed(String(menu)))),
          ...(allowed('warehouse') ? { warehouse: c.warehouse || 0 } : {}),
        }
      }
      case 'orders': {
        const result = await supabase.rpc('get_orders_sidebar_actionable_count', { p_username: adminName, p_role: context.role })
        if (!result.error) return { counts: { orders: Number(result.data || 0) } }
        const c = await base()
        return { counts: { orders: (c.orders || 0) + (c.orders_req_claim_shipping || 0) } }
      }
      case 'account': {
        const [c, waiver] = await Promise.all([base(), count(supabase.from('ac_overpayment_waivers')
          .select('id, or_orders!inner(status)', { count: 'exact', head: true }).eq('status', 'pending').neq('or_orders.status', 'ยกเลิก'))])
        return { counts: { account: (c.refund_pending || 0) + waiver + (c.tax_pending || 0)
          + (c.manual_slip_pending || 0) + (c.amendment_pending || 0) + (c.claim_pending || 0) } }
      }
      case 'qc': {
        const [c, workOrders] = await Promise.all([base(), fetchWorkOrdersWithProgress(true, context.scope)])
        return { counts: { qc: workOrders.length + (c.qc_reject || 0) } }
      }
      case 'wms': return { counts: { wms: (await loadWmsTabCounts(context.scope)).total } }
      case 'returns': return { returns: await loadPendingReturns(context.scope) }
      case 'purchase': {
        const purchase = await loadPurchaseBadgeCounts()
        return { purchase, counts: { purchase: purchase.pr_pending + purchase.machinery_pending + purchase.pr_approved_no_po + purchase.po_waiting_gr } }
      }
      case 'plan': return { counts: { plan: await count(supabase.from('or_orders').select('id', { count: 'exact', head: true }).or(PLAN_WORK_QUEUE_POSTGREST_FILTER).is('work_order_id', null)) } }
      case 'machinery': {
        const [warning, critical] = await Promise.all([
          count(supabase.from('pr_machinery_machines').select('id', { count: 'exact', head: true }).eq('current_status', 'power_off')),
          count(supabase.from('pr_machinery_machines').select('id', { count: 'exact', head: true }).in('current_status', ['broken', 'repairing'])),
        ])
        return { counts: { machinery: warning + critical }, machinery: { warning, critical } }
      }
      case 'hr': {
        return { counts: { hr: (await loadHrPendingCounts(context.scope)).total } }
      }
      case 'marketplace': return { counts: { marketplace: await count(isAdminOrSuperadmin(context.role)
        ? supabase.from('mp_orders').select('id', { count: 'exact', head: true }).eq('status', 'new')
        : supabase.from('mp_orders').select('id', { count: 'exact', head: true }).in('status', ['assigned', 'follow_up'])) } }
    }
  }
  const groups = [...new Set(requested)].filter(group => enabled.includes(group))
  const results = await Promise.allSettled(groups.map(group => operationalCountCache.read(keyFor(context, group), () => load(group))))
  return results.flatMap((result, i) => {
    if (result.status === 'fulfilled') return [{ group: groups[i], patch: result.value }]
    console.error(`Sidebar count ${groups[i]}:`, result.reason)
    return [] // Keep the previous successful value instead of publishing a false zero.
  })
}
