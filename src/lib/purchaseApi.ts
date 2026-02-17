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
}

export async function createPR(input: CreatePRInput) {
  const { data, error } = await supabase.rpc('rpc_create_pr', {
    p_items: input.items,
    p_note: input.note || null,
    p_user_id: input.userId || null,
  })
  if (error) throw error
  return data as { id: string; pr_no: string }
}

export async function approvePR(prId: string, userId: string) {
  const { error } = await supabase
    .from('inv_pr')
    .update({
      status: 'approved',
      approved_by: userId,
      approved_at: new Date().toISOString(),
    })
    .eq('id', prId)
  if (error) throw error
}

export async function rejectPR(prId: string, userId: string, reason: string) {
  const { error } = await supabase
    .from('inv_pr')
    .update({
      status: 'rejected',
      rejected_by: userId,
      rejected_at: new Date().toISOString(),
      rejection_reason: reason,
    })
    .eq('id', prId)
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
    .select('*, inv_pr(pr_no), inv_po_items(id)')
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
}

export async function convertPRtoPO(input: ConvertPRtoPOInput) {
  const { data, error } = await supabase.rpc('rpc_convert_pr_to_po', {
    p_pr_id: input.prId,
    p_supplier_id: input.supplierId || null,
    p_supplier_name: input.supplierName || null,
    p_prices: input.prices || [],
    p_note: input.note || null,
  })
  if (error) throw error
  return data as { id: string; po_no: string; total_amount: number }
}

export async function markPOOrdered(poId: string, userId: string) {
  const { error } = await supabase
    .from('inv_po')
    .update({
      status: 'ordered',
      ordered_by: userId,
      ordered_at: new Date().toISOString(),
    })
    .eq('id', poId)
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
    .select('*, inv_po(po_no), inv_gr_items(id)')
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

/* ──────────────── Ordered POs without GR ──────────────── */

export async function loadOrderedPOsWithoutGR(): Promise<InventoryPO[]> {
  const { data: allOrdered, error: poErr } = await supabase
    .from('inv_po')
    .select('*, inv_po_items(id, product_id, qty, unit_price, pr_products(product_code, product_name))')
    .eq('status', 'ordered')
    .order('created_at', { ascending: false })
  if (poErr) throw poErr

  const { data: allGRs, error: grErr } = await supabase
    .from('inv_gr')
    .select('po_id')
    .not('po_id', 'is', null)
  if (grErr) throw grErr

  const usedPoIds = new Set((allGRs || []).map((g: any) => g.po_id))
  return ((allOrdered || []) as unknown as InventoryPO[]).filter((po) => !usedPoIds.has(po.id))
}
