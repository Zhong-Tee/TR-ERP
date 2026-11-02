import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), qc: vi.fn(), wms: vi.fn(), purchase: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }))
vi.mock('./qcApi', () => ({ fetchWorkOrdersWithProgress: mocks.qc }))
vi.mock('./purchaseApi', () => ({ loadPurchaseBadgeCounts: mocks.purchase }))
vi.mock('../components/wms/wmsUtils', () => ({ loadWmsTabCounts: mocks.wms }))
import { invalidateSidebarCounts, readSidebarCounts, SIDEBAR_COUNT_GROUPS, SIDEBAR_COUNT_TABLES,
  sidebarGroupsForContextTable, sidebarGroupsForEvent, sidebarGroupsForTable, type SidebarCountContext } from './sidebarCounts'
import { loadHrPendingCounts, loadPendingReturns } from './operationalBadges'

let identity = 0
function context(allowed: string[], role = 'packing_staff'): SidebarCountContext {
  return { scope: `test-${++identity}`, role, username: 'Operator', allowed }
}
function query(result: { count: number | null; error: unknown }) {
  const builder = {
    select: vi.fn(), eq: vi.fn(), neq: vi.fn(), in: vi.fn(), or: vi.fn(), is: vi.fn(),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  }
  for (const method of [builder.select, builder.eq, builder.neq, builder.in, builder.or, builder.is]) method.mockReturnValue(builder)
  return builder
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.from.mockImplementation(() => query({ count: 3, error: null }))
  mocks.rpc.mockImplementation((name: string) => Promise.resolve({ error: null, data: name === 'get_orders_sidebar_actionable_count'
    ? 8 : { packing: 2, warehouse: 4, admin_qc: 5, qc_reject: 1, refund_pending: 2, tax_pending: 3,
      manual_slip_pending: 4, amendment_pending: 5, claim_pending: 6 } }))
  mocks.qc.mockResolvedValue([{}, {}])
  mocks.wms.mockResolvedValue({ total: 9, counts: {} })
  mocks.purchase.mockResolvedValue({ pr_pending: 1, machinery_pending: 2, pr_approved_no_po: 3, po_waiting_gr: 4 })
})

describe('permission-aware sidebar counts', () => {
  it('packing-only users perform one lightweight count and no QC/WMS/HR/account reads', async () => {
    const result = await readSidebarCounts(context(['packing']), SIDEBAR_COUNT_GROUPS)
    expect(result).toEqual([{ group: 'core', patch: { counts: { packing: 3 } } }])
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual(['or_work_orders'])
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.qc).not.toHaveBeenCalled()
    expect(mocks.wms).not.toHaveBeenCalled()
    expect(mocks.purchase).not.toHaveBeenCalled()
  })
  it('deduplicates initial/navigation reads and refreshes after a relevant event', async () => {
    const actor = context(['packing'])
    await Promise.all([readSidebarCounts(actor, SIDEBAR_COUNT_GROUPS), readSidebarCounts(actor, SIDEBAR_COUNT_GROUPS)])
    await readSidebarCounts(actor, SIDEBAR_COUNT_GROUPS)
    expect(mocks.from).toHaveBeenCalledTimes(1)
    invalidateSidebarCounts(actor, ['core'])
    await readSidebarCounts(actor, ['core'])
    expect(mocks.from).toHaveBeenCalledTimes(2)
  })
  it('limits packing-only realtime subscriptions to the table that determines its badge', () => {
    const actor = context(['packing'])
    expect(SIDEBAR_COUNT_TABLES.filter(table => sidebarGroupsForContextTable(actor, table).length))
      .toEqual(['or_work_orders'])
  })
  it('an HR change does not trigger production, QC or WMS reads', async () => {
    const result = await readSidebarCounts(context(['hr', 'qc', 'wms']), sidebarGroupsForTable('hr_ot_requests'))
    expect(result[0].patch.counts).toEqual({ hr: 9 })
    expect(mocks.from.mock.calls.map(call => call[0])).toEqual(['hr_leave_requests', 'hr_ot_requests', 'hr_wfh_requests'])
    expect(mocks.qc).not.toHaveBeenCalled()
    expect(mocks.wms).not.toHaveBeenCalled()
  })
  it('shares HR and returns reads with the TopBar helpers and invalidates both after events', async () => {
    const actor = context(['hr', 'warehouse'])
    await Promise.all([loadHrPendingCounts(actor.scope), loadPendingReturns(actor.scope)])
    await readSidebarCounts(actor, ['hr', 'returns'])
    expect(mocks.from).toHaveBeenCalledTimes(4)
    invalidateSidebarCounts(actor, ['hr', 'returns'])
    await readSidebarCounts(actor, ['hr', 'returns'])
    expect(mocks.from).toHaveBeenCalledTimes(8)
  })
  it('ignores metadata-only parcel scans, but retains relevant changes and incomplete payloads', () => {
    const actor = context(['orders', 'account', 'qc', 'wms', 'plan', 'warehouse', 'admin-qc'])
    const old = { id: 'o', status: 'ใบสั่งงาน', channel_code: 'WEB', admin_user: 'A', entry_date: '2026-11-02',
      claim_type: null, claim_shipping_confirmed_at: null, failed_queue_archived_at: null,
      billing_details: {}, work_order_id: 'wo', work_order_name: 'WO', bill_no: 'B' }
    expect(sidebarGroupsForEvent(actor, 'or_orders', { eventType: 'UPDATE', old, new: { ...old, packing_meta: { tag: 1 } } })).toEqual([])
    expect(sidebarGroupsForEvent(actor, 'or_orders', { eventType: 'UPDATE', old, new: { ...old, status: 'ยกเลิก' } }))
      .toEqual(['core', 'orders', 'account', 'qc', 'wms', 'plan'])
    expect(sidebarGroupsForEvent(actor, 'or_orders', { eventType: 'UPDATE', old: { id: 'o' }, new: old })).toHaveLength(6)
  })
  it('keeps account/QC/orders formulas and shares the base RPC', async () => {
    const result = await readSidebarCounts(context(['account', 'qc', 'orders', 'warehouse', 'packing', 'admin-qc'], 'admin'), SIDEBAR_COUNT_GROUPS)
    const patch = Object.assign({}, ...result.map(row => row.patch.counts))
    expect(patch).toEqual({ account: 23, qc: 3, orders: 8, warehouse: 4, packing: 2, 'admin-qc': 5 })
    expect(mocks.rpc.mock.calls.filter(call => call[0] === 'get_sidebar_counts')).toHaveLength(1)
  })
  it('does not publish zero badges when an individual group fails', async () => {
    const actor = context(['qc', 'packing'])
    mocks.qc.mockRejectedValueOnce(new Error('network'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await readSidebarCounts(actor, ['qc', 'core'])
    expect(result).toEqual([{ group: 'core', patch: { counts: { packing: 3 } } }])
    expect(log).toHaveBeenCalled()
    log.mockRestore()
    expect((await readSidebarCounts(actor, ['qc']))[0].patch.counts).toEqual({ qc: 3 })
  })
  it('keeps purchase/machinery/marketplace results and identity scopes separate', async () => {
    const actor = context(['purchase', 'machinery', 'marketplace'], 'admin')
    const result = await readSidebarCounts(actor, SIDEBAR_COUNT_GROUPS)
    expect(Object.assign({}, ...result.map(row => row.patch.counts))).toEqual({ purchase: 10, machinery: 6, marketplace: 3 })
    await readSidebarCounts({ ...actor, scope: 'another-user' }, SIDEBAR_COUNT_GROUPS)
    expect(mocks.purchase).toHaveBeenCalledTimes(2)
  })
})
