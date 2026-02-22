/**
 * Purchase API: Centralized queries for PR / PO / GR / Sample
 * All read operations use nested select (1 API call).
 * All complex write operations use RPC functions (1 API call).
 */
import { supabase } from './supabase'
import type {
  InventoryPR,
  InventoryPO,
  InventoryPOItem,
  InventoryGR,
  InventorySample,
  Product,
} from '../types'

/* ──────────────── User Display Names ──────────────── */

export async function loadUserDisplayNames(userIds: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(userIds.filter(Boolean))]
  if (!unique.length) return {}
  const { data, error } = await supabase
    .from('us_users')
    .select('id, username, email')
    .in('id', unique)
  if (error) throw error
  const map: Record<string, string> = {}
  for (const u of (data || [])) {
    map[u.id] = u.username || u.email || u.id
  }
  return map
}

/* ──────────────── Products ──────────────── */

export async function loadProductsWithLastPrice(): Promise<(Product & { last_price?: number | null })[]> {
  const { data, error } = await supabase
    .from('pr_products')
    .select('*, v_product_last_price(last_price)')
    .eq('is_active', true)
    .order('product_code')
  if (error) throw error
  return (data || []).map((p: any) => ({
    ...p,
    last_price: p.v_product_last_price?.last_price ?? null,
  }))
}

/* ──────────────── Stock Balances ──────────────── */

export async function loadStockBalances(): Promise<Record<string, number>> {
  const { data, error } = await supabase
    .from('inv_stock_balances')
    .select('product_id, on_hand')
  if (error) throw error
  const map: Record<string, number> = {}
  for (const row of (data || [])) {
    map[row.product_id] = Number(row.on_hand) || 0
  }
  return map
}

/* ──────────────── PR (Purchase Requisition) ──────────────── */

export interface PRListFilters {
  status?: string
  search?: string
  dateFrom?: string
  dateTo?: string
  prType?: string
}

export async function loadPRList(filters: PRListFilters = {}): Promise<InventoryPR[]> {
  let q = supabase
    .from('inv_pr')
    .select('*, inv_pr_items(id)')
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') {
    q = q.eq('status', filters.status)
  }
  if (filters.search) {
    q = q.ilike('pr_no', `%${filters.search}%`)
  }
  if (filters.dateFrom) {
    q = q.gte('created_at', filters.dateFrom)
  }
  if (filters.dateTo) {
    q = q.lte('created_at', filters.dateTo + 'T23:59:59')
  }
  if (filters.prType && filters.prType !== 'all') {
    q = q.eq('pr_type', filters.prType)
  }

  const { data, error } = await q
  if (error) throw error
  return (data || []) as unknown as InventoryPR[]
}

export async function loadPRDetail(prId: string) {
  const { data, error } = await supabase
    .from('inv_pr')
    .select(`
      *,
      inv_pr_items(
        *,
        pr_products(id, product_code, product_name, product_name_cn, seller_name, product_category, product_type, unit_cost, storage_location)
      )
    `)
    .eq('id', prId)
    .single()
  if (error) throw error
  return data as unknown as InventoryPR
}

export interface CreatePRInput {
  items: {
    product_id: string
    qty: number
    unit?: string
    estimated_price?: number | null
    note?: string
  }[]
  note?: string
  userId?: string
  prType?: string
  supplierId?: string
  supplierName?: string
}

export async function createPR(input: CreatePRInput) {
  const { data, error } = await supabase.rpc('rpc_create_pr', {
    p_items: input.items,
    p_note: input.note || null,
    p_user_id: input.userId || null,
    p_pr_type: input.prType || 'normal',
    p_supplier_id: input.supplierId || null,
    p_supplier_name: input.supplierName || null,
  })
  if (error) throw error
  return data as { id: string; pr_no: string }
}

export async function approvePR(prId: string, userId: string) {
  const { error } = await supabase.rpc('rpc_approve_pr', {
    p_pr_id: prId,
    p_user_id: userId,
  })
  if (error) throw error
}

export async function rejectPR(prId: string, userId: string, reason: string) {
  const { error } = await supabase.rpc('rpc_reject_pr', {
    p_pr_id: prId,
    p_user_id: userId,
    p_reason: reason,
  })
  if (error) throw error
}

export async function cancelPR(prId: string) {
  const { error } = await supabase
    .from('inv_pr')
    .update({ status: 'cancelled' })
    .eq('id', prId)
    .eq('status', 'pending')
  if (error) throw error
}

export async function updatePR(input: {
  prId: string
  items: { product_id: string; qty: number; unit?: string; estimated_price?: number | null; note?: string }[]
  note?: string
  prType?: string
  supplierId?: string
  supplierName?: string
}) {
  const { error } = await supabase.rpc('rpc_update_pr', {
    p_pr_id: input.prId,
    p_items: input.items,
    p_note: input.note || null,
    p_pr_type: input.prType || null,
    p_supplier_id: input.supplierId || null,
    p_supplier_name: input.supplierName || null,
  })
  if (error) throw error
}

/* ──────────────── PO (Purchase Order) ──────────────── */

export interface POListFilters {
  status?: string
  search?: string
  dateFrom?: string
  dateTo?: string
}

export async function loadPOList(filters: POListFilters = {}): Promise<InventoryPO[]> {
  let q = supabase
    .from('inv_po')
    .select('*, inv_pr(pr_no, pr_type), inv_po_items(id, qty)')
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') {
    q = q.eq('status', filters.status)
  }
  if (filters.search) {
    q = q.ilike('po_no', `%${filters.search}%`)
  }
  if (filters.dateFrom) {
    q = q.gte('created_at', filters.dateFrom)
  }
  if (filters.dateTo) {
    q = q.lte('created_at', filters.dateTo + 'T23:59:59')
  }

  const { data, error } = await q
  if (error) throw error
  return (data || []) as unknown as InventoryPO[]
}

export async function loadPODetail(poId: string) {
  const { data, error } = await supabase
    .from('inv_po')
    .select(`
      *,
      inv_pr(pr_no),
      inv_po_items(
        *,
        pr_products(id, product_code, product_name, product_name_cn, seller_name, product_category)
      )
    `)
    .eq('id', poId)
    .single()
  if (error) throw error
  return data as unknown as InventoryPO
}

export interface ConvertPRtoPOInput {
  prId: string
  supplierId?: string | null
  supplierName?: string | null
  prices?: { product_id: string; unit_price: number }[]
  note?: string
  userId?: string
  expectedArrivalDate?: string | null
}

export async function convertPRtoPO(input: ConvertPRtoPOInput) {
  const { data, error } = await supabase.rpc('rpc_convert_pr_to_po', {
    p_pr_id: input.prId,
    p_supplier_id: input.supplierId || null,
    p_supplier_name: input.supplierName || null,
    p_prices: input.prices || [],
    p_note: input.note || null,
    p_user_id: input.userId || null,
  })
  if (error) throw error
  const result = data as { id: string; po_no: string; total_amount: number }

  if (input.expectedArrivalDate) {
    await supabase.from('inv_po').update({ expected_arrival_date: input.expectedArrivalDate }).eq('id', result.id)
  }

  return result
}

export async function markPOOrdered(poId: string, userId: string) {
  const { error } = await supabase.rpc('rpc_mark_po_ordered', {
    p_po_id: poId,
    p_user_id: userId,
  })
  if (error) throw error
}

export async function updatePOShipping(poId: string, shipping: {
  intl_shipping_method?: string
  intl_shipping_weight?: number
  intl_shipping_cbm?: number
  intl_shipping_cost?: number
  intl_shipping_currency?: string
  intl_exchange_rate?: number
  intl_shipping_cost_thb?: number
  grand_total?: number
}) {
  const { error } = await supabase
    .from('inv_po')
    .update(shipping)
    .eq('id', poId)
  if (error) throw error
}

export async function recalcPOLandedCost(poId: string) {
  const { error } = await supabase.rpc('rpc_recalc_po_landed_cost', { p_po_id: poId })
  if (error) throw error
}

export async function updatePO(input: {
  poId: string
  note?: string
  expectedArrivalDate?: string | null
  items: { item_id: string; unit_price: number | null; qty?: number; note?: string }[]
}) {
  const { data, error } = await supabase.rpc('rpc_update_po', {
    p_po_id: input.poId,
    p_note: input.note ?? null,
    p_expected_arrival_date: input.expectedArrivalDate || null,
    p_items: input.items,
  })
  if (error) throw error
  return data as { total_amount: number }
}

/* ──────────────── GR (Goods Receipt) ──────────────── */

export interface GRListFilters {
  status?: string
  search?: string
  dateFrom?: string
  dateTo?: string
}

export async function loadGRList(filters: GRListFilters = {}): Promise<InventoryGR[]> {
  let q = supabase
    .from('inv_gr')
    .select('*, inv_po(po_no, inv_pr(pr_type)), inv_gr_items(id, qty_ordered, qty_received)')
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') {
    q = q.eq('status', filters.status)
  }
  if (filters.search) {
    q = q.ilike('gr_no', `%${filters.search}%`)
  }
  if (filters.dateFrom) {
    q = q.gte('created_at', filters.dateFrom)
  }
  if (filters.dateTo) {
    q = q.lte('created_at', filters.dateTo + 'T23:59:59')
  }

  const { data, error } = await q
  if (error) throw error
  return (data || []) as unknown as InventoryGR[]
}

export async function loadGRDetail(grId: string) {
  const { data, error } = await supabase
    .from('inv_gr')
    .select(`
      *,
      inv_po(po_no),
      inv_gr_items(
        *,
        pr_products(id, product_code, product_name, product_name_cn, seller_name)
      )
    `)
    .eq('id', grId)
    .single()
  if (error) throw error
  return data as unknown as InventoryGR
}

export interface ReceiveGRInput {
  poId: string
  items: {
    product_id: string
    qty_received: number
    qty_ordered: number
    shortage_note?: string
  }[]
  shipping?: {
    dom_shipping_company?: string
    dom_shipping_cost?: number
    note?: string
    shortage_note?: string
  }
  userId?: string
}

export async function receiveGR(input: ReceiveGRInput) {
  const { data, error } = await supabase.rpc('rpc_receive_gr', {
    p_po_id: input.poId,
    p_items: input.items,
    p_shipping: input.shipping || {},
    p_user_id: input.userId || null,
  })
  if (error) throw error
  return data as { id: string; gr_no: string; status: string; total_received: number }
}

/* ──────────────── PO items for GR form ──────────────── */

export async function loadPOItemsForGR(poId: string) {
  const { data, error } = await supabase
    .from('inv_po_items')
    .select('*, pr_products(id, product_code, product_name, product_name_cn)')
    .eq('po_id', poId)
  if (error) throw error
  return (data || []) as unknown as InventoryPOItem[]
}

export async function loadPODetailWithItems(poId: string) {
  const { data, error } = await supabase
    .from('inv_po')
    .select(`
      *,
      inv_pr(pr_no),
      inv_po_items(
        *,
        pr_products(id, product_code, product_name, product_name_cn, seller_name, product_category)
      )
    `)
    .eq('id', poId)
    .single()
  if (error) throw error
  return data as unknown as InventoryPO
}

/* ──────────────── Samples ──────────────── */

export interface SampleListFilters {
  status?: string
  search?: string
}

export async function loadSamples(filters: SampleListFilters = {}): Promise<InventorySample[]> {
  let q = supabase
    .from('inv_samples')
    .select('*, inv_sample_items(id)')
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') {
    q = q.eq('status', filters.status)
  }
  if (filters.search) {
    q = q.ilike('sample_no', `%${filters.search}%`)
  }

  const { data, error } = await q
  if (error) throw error
  return (data || []) as unknown as InventorySample[]
}

export async function loadSampleDetail(sampleId: string) {
  const { data, error } = await supabase
    .from('inv_samples')
    .select(`
      *,
      inv_sample_items(
        *,
        pr_products(id, product_code, product_name, product_name_cn)
      )
    `)
    .eq('id', sampleId)
    .single()
  if (error) throw error
  return data as unknown as InventorySample
}

export interface CreateSampleInput {
  items: {
    product_id?: string | null
    product_name_manual?: string
    qty: number
    note?: string
  }[]
  supplierName?: string
  note?: string
  userId?: string
}

export async function createSample(input: CreateSampleInput) {
  const { data, error } = await supabase.rpc('rpc_create_sample', {
    p_items: input.items,
    p_supplier_name: input.supplierName || null,
    p_note: input.note || null,
    p_user_id: input.userId || null,
  })
  if (error) throw error
  return data as { id: string; sample_no: string }
}

export async function updateSampleTest(
  sampleId: string,
  status: 'testing' | 'approved' | 'rejected',
  opts?: {
    userId?: string
    testNote?: string
    rejectionReason?: string
    itemResults?: { item_id: string; result: string; note?: string }[]
  }
) {
  const { error } = await supabase.rpc('rpc_update_sample_test', {
    p_sample_id: sampleId,
    p_status: status,
    p_user_id: opts?.userId || null,
    p_test_note: opts?.testNote || null,
    p_rejection_reason: opts?.rejectionReason || null,
    p_item_results: opts?.itemResults || [],
  })
  if (error) throw error
}

export async function convertSampleToProduct(input: {
  sampleId: string
  itemId: string
  productCode: string
  productName: string
  productNameCn?: string
  productType?: string
  productCategory?: string
  sellerName?: string
  unitCost?: number
  userId?: string
}) {
  const { data, error } = await supabase.rpc('rpc_convert_sample_to_product', {
    p_sample_id: input.sampleId,
    p_item_id: input.itemId,
    p_product_code: input.productCode,
    p_product_name: input.productName,
    p_product_name_cn: input.productNameCn || null,
    p_product_type: input.productType || 'FG',
    p_product_category: input.productCategory || null,
    p_seller_name: input.sellerName || null,
    p_unit_cost: input.unitCost ?? null,
    p_user_id: input.userId || null,
  })
  if (error) throw error
  return data as string
}

/* ──────────────── Purchase Badge Counts ──────────────── */

export async function loadPurchaseBadgeCounts(): Promise<{ pr_pending: number; pr_approved_no_po: number; po_waiting_gr: number }> {
  const { data, error } = await supabase.rpc('get_purchase_badge_counts')
  if (error) throw error
  return data as { pr_pending: number; pr_approved_no_po: number; po_waiting_gr: number }
}

/* ──────────────── Sellers ──────────────── */

export async function loadSellers() {
  const { data, error } = await supabase
    .from('pr_sellers')
    .select('id, name, name_cn')
    .eq('is_active', true)
    .order('name')
  if (error) throw error
  return data || []
}

/* ──────────────── Approved PRs without PO ──────────────── */

export async function loadApprovedPRsWithoutPO(): Promise<InventoryPR[]> {
  const { data: allApproved, error: prErr } = await supabase
    .from('inv_pr')
    .select('*, inv_pr_items(id, product_id, qty, unit, estimated_price, pr_products(product_code, product_name))')
    .eq('status', 'approved')
    .order('created_at', { ascending: false })
  if (prErr) throw prErr

  const { data: allPOs, error: poErr } = await supabase
    .from('inv_po')
    .select('pr_id')
    .not('pr_id', 'is', null)
  if (poErr) throw poErr

  const usedPrIds = new Set((allPOs || []).map((p: any) => p.pr_id))
  return ((allApproved || []) as unknown as InventoryPR[]).filter((pr) => !usedPrIds.has(pr.id))
}

/* ──────────────── POs available for GR (ordered + partial) ──────────────── */

export async function loadPOsForGR(): Promise<{ newPOs: InventoryPO[]; partialPOs: InventoryPO[] }> {
  const { data: allOrdered, error: poErr } = await supabase
    .from('inv_po')
    .select('*, inv_pr(pr_no, note, supplier_name), inv_po_items(id, product_id, qty, qty_received_total, unit_price, note, pr_products(product_code, product_name))')
    .in('status', ['ordered', 'partial'])
    .order('created_at', { ascending: false })
  if (poErr) throw poErr

  const { data: allGRs, error: grErr } = await supabase
    .from('inv_gr')
    .select('po_id')
    .not('po_id', 'is', null)
  if (grErr) throw grErr

  const usedPoIds = new Set((allGRs || []).map((g: any) => g.po_id))
  const all = (allOrdered || []) as unknown as InventoryPO[]

  const newPOs = all.filter((po) => po.status === 'ordered' && !usedPoIds.has(po.id))
  const partialPOs = all.filter((po) => po.status === 'partial')

  return { newPOs, partialPOs }
}

/* ──────────────── GRs for a specific PO (history) ──────────────── */

export async function loadGRsForPO(poId: string): Promise<InventoryGR[]> {
  const { data, error } = await supabase
    .from('inv_gr')
    .select('*, inv_gr_items(id, product_id, qty_ordered, qty_received, qty_shortage)')
    .eq('po_id', poId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as unknown as InventoryGR[]
}

/* ──────────────── Resolve PO shortage ──────────────── */

export interface ResolveShortageInput {
  poId: string
  resolutions: {
    po_item_id: string
    resolution_type: string
    resolution_qty: number
    resolution_note?: string
  }[]
  userId?: string
}

export async function resolveShortage(input: ResolveShortageInput) {
  const { data, error } = await supabase.rpc('rpc_resolve_po_shortage', {
    p_po_id: input.poId,
    p_resolutions: input.resolutions,
    p_user_id: input.userId || null,
  })
  if (error) throw error
  return data as { success: boolean; updated_count: number; po_status: string }
}
