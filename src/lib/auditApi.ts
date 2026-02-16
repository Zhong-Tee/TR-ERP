import { supabase } from './supabase'
import type { AuditType, InventoryAudit, InventoryAuditItem } from '../types'

// ── Helpers ──────────────────────────────────────────────────

export function generateAuditNo() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const rand = Math.floor(Math.random() * 9000) + 1000
  return `AUDIT-${y}${m}${day}-${rand}`
}

// ── Fetch Helpers ────────────────────────────────────────────

export async function fetchAudits() {
  const { data, error } = await supabase
    .from('inv_audits')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as InventoryAudit[]
}

export async function fetchAuditById(id: string) {
  const { data, error } = await supabase
    .from('inv_audits')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return data as InventoryAudit
}

export async function fetchAuditItems(auditId: string) {
  const { data, error } = await supabase
    .from('inv_audit_items')
    .select('*, pr_products(product_code, product_name, storage_location, product_category)')
    .eq('audit_id', auditId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data || []) as InventoryAuditItem[]
}

export async function fetchAuditorAssignedAudits(userId: string) {
  const { data, error } = await supabase
    .from('inv_audits')
    .select('*')
    .contains('assigned_to', [userId])
    .in('status', ['in_progress'])
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as InventoryAudit[]
}

// ── Create Audit ─────────────────────────────────────────────

interface CreateAuditInput {
  auditType: AuditType
  scopeFilter?: Record<string, string[]>
  assignedTo: string[]
  note?: string
  userId: string
}

export async function createAudit(input: CreateAuditInput) {
  const auditNo = generateAuditNo()

  // 1. สร้าง audit header
  const { data: audit, error: auditErr } = await supabase
    .from('inv_audits')
    .insert({
      audit_no: auditNo,
      status: 'in_progress',
      audit_type: input.auditType,
      scope_filter: input.scopeFilter || null,
      assigned_to: input.assignedTo,
      frozen_at: new Date().toISOString(),
      created_by: input.userId,
      note: input.note?.trim() || null,
    })
    .select('*')
    .single()
  if (auditErr) throw auditErr

  // 2. ดึงสินค้าตาม scope
  let productQuery = supabase
    .from('pr_products')
    .select('id, product_code, product_name, product_category, storage_location')
    .eq('is_active', true)

  if (input.auditType === 'category' && input.scopeFilter?.categories?.length) {
    productQuery = productQuery.in('product_category', input.scopeFilter.categories)
  } else if (input.auditType === 'location' && input.scopeFilter?.locations?.length) {
    const locationFilters = input.scopeFilter.locations
      .map((loc) => `storage_location.ilike.%${loc}%`)
      .join(',')
    productQuery = productQuery.or(locationFilters)
  } else if (input.auditType === 'custom' && input.scopeFilter?.product_ids?.length) {
    productQuery = productQuery.in('id', input.scopeFilter.product_ids)
  }

  const { data: products, error: prodErr } = await productQuery
  if (prodErr) throw prodErr
  if (!products?.length) throw new Error('ไม่พบสินค้าตามเงื่อนไขที่เลือก')

  // 3. ดึง stock balance + safety stock
  const productIds = products.map((p) => p.id)
  const { data: balances } = await supabase
    .from('inv_stock_balances')
    .select('product_id, on_hand, safety_stock')
    .in('product_id', productIds)

  const balanceMap: Record<string, { on_hand: number; safety_stock: number }> = {}
  ;(balances || []).forEach((b: any) => {
    balanceMap[b.product_id] = {
      on_hand: Number(b.on_hand || 0),
      safety_stock: Number(b.safety_stock || 0),
    }
  })

  // 4. สร้าง audit items พร้อม snapshot
  const items = products.map((p) => {
    const bal = balanceMap[p.id] || { on_hand: 0, safety_stock: 0 }
    return {
      audit_id: audit.id,
      product_id: p.id,
      system_qty: bal.on_hand,
      counted_qty: 0,
      variance: 0,
      is_counted: false,
      storage_location: p.storage_location || null,
      product_category: p.product_category || null,
      system_location: p.storage_location || null,
      system_safety_stock: bal.safety_stock,
    }
  })

  const { error: itemErr } = await supabase.from('inv_audit_items').insert(items)
  if (itemErr) throw itemErr

  // 5. อัปเดต total_items แล้ว return ค่าล่าสุด
  const { data: updatedAudit, error: updateErr } = await supabase
    .from('inv_audits')
    .update({ total_items: items.length })
    .eq('id', audit.id)
    .select('*')
    .single()
  if (updateErr) throw updateErr

  return updatedAudit as InventoryAudit
}

// ── Save Count (single item) ─────────────────────────────────

interface SaveCountInput {
  auditItemId: string
  countedQty: number
  locationMatch: boolean
  actualLocation?: string | null
  countedSafetyStock?: number | null
  countedBy: string
}

export async function saveCount(input: SaveCountInput) {
  const now = new Date().toISOString()

  // 1. ดึง system_qty เพื่อคำนวณ variance
  const { data: item, error: fetchErr } = await supabase
    .from('inv_audit_items')
    .select('system_qty, system_safety_stock')
    .eq('id', input.auditItemId)
    .single()
  if (fetchErr) throw fetchErr

  const systemQty = Number(item.system_qty || 0)
  const variance = input.countedQty - systemQty

  const systemSafety = Number(item.system_safety_stock || 0)
  const safetyMatch = input.countedSafetyStock != null
    ? input.countedSafetyStock === systemSafety
    : null

  // 2. อัปเดต audit item
  const { error: updateErr } = await supabase
    .from('inv_audit_items')
    .update({
      counted_qty: input.countedQty,
      variance,
      is_counted: true,
      counted_by: input.countedBy,
      counted_at: now,
      location_match: input.locationMatch,
      actual_location: input.locationMatch ? null : (input.actualLocation || null),
      counted_safety_stock: input.countedSafetyStock ?? null,
      safety_stock_match: safetyMatch,
    })
    .eq('id', input.auditItemId)
  if (updateErr) throw updateErr

  // 3. บันทึก log
  await supabase.from('inv_audit_count_logs').insert({
    audit_item_id: input.auditItemId,
    log_type: 'count',
    counted_qty: input.countedQty,
    actual_location: input.locationMatch ? null : (input.actualLocation || null),
    counted_safety_stock: input.countedSafetyStock ?? null,
    counted_by: input.countedBy,
    counted_at: now,
  })
}

// ── Complete Audit (คำนวณ KPI) ───────────────────────────────

export async function submitAuditForReview(auditId: string) {
  const items = await fetchAuditItems(auditId)
  const countedItems = items.filter((i) => i.is_counted)

  const totalItems = countedItems.length
  if (totalItems === 0) throw new Error('ยังไม่มีรายการที่ถูกนับ')

  // Quantity accuracy
  const qtyMatched = countedItems.filter((i) => Number(i.variance) === 0).length
  const totalVariance = countedItems.reduce((sum, i) => sum + Math.abs(Number(i.variance || 0)), 0)
  const accuracyPercent = (qtyMatched / totalItems) * 100

  // Location accuracy
  const locationChecked = countedItems.filter((i) => i.location_match !== null)
  const locationMatched = locationChecked.filter((i) => i.location_match === true).length
  const locationMismatches = locationChecked.length - locationMatched
  const locationAccuracy = locationChecked.length > 0
    ? (locationMatched / locationChecked.length) * 100
    : null

  // Safety stock accuracy
  const safetyChecked = countedItems.filter((i) => i.safety_stock_match !== null)
  const safetyMatched = safetyChecked.filter((i) => i.safety_stock_match === true).length
  const safetyMismatches = safetyChecked.length - safetyMatched
  const safetyAccuracy = safetyChecked.length > 0
    ? (safetyMatched / safetyChecked.length) * 100
    : null

  const { error } = await supabase
    .from('inv_audits')
    .update({
      status: 'review',
      total_items: totalItems,
      total_variance: totalVariance,
      accuracy_percent: Number.isFinite(accuracyPercent) ? accuracyPercent : 0,
      location_accuracy_percent: locationAccuracy != null && Number.isFinite(locationAccuracy) ? locationAccuracy : null,
      safety_stock_accuracy_percent: safetyAccuracy != null && Number.isFinite(safetyAccuracy) ? safetyAccuracy : null,
      total_location_mismatches: locationMismatches,
      total_safety_stock_mismatches: safetyMismatches,
    })
    .eq('id', auditId)
  if (error) throw error
}

// ── Complete / Close Audit ───────────────────────────────────

export async function completeAudit(auditId: string, reviewedBy: string) {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('inv_audits')
    .update({
      status: 'completed',
      completed_at: now,
      reviewed_by: reviewedBy,
      reviewed_at: now,
    })
    .eq('id', auditId)
  if (error) throw error
}

export async function closeAudit(auditId: string) {
  const { error } = await supabase
    .from('inv_audits')
    .update({ status: 'closed' })
    .eq('id', auditId)
  if (error) throw error
}

// ── Create Adjustment from Audit ─────────────────────────────

export async function createAdjustmentFromAudit(auditId: string, userId: string) {
  const items = await fetchAuditItems(auditId)
  const varianceItems = items.filter((i) => i.is_counted && Number(i.variance) !== 0)
  const locationItems = items.filter((i) => i.location_match === false && i.actual_location)

  if (!varianceItems.length && !locationItems.length) {
    throw new Error('ไม่มีรายการที่ต้องปรับ')
  }

  const d = new Date()
  const adjustNo = `ADJ-AUDIT-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${Math.floor(Math.random() * 9000) + 1000}`

  // Fetch audit info
  const audit = await fetchAuditById(auditId)

  // สร้างใบปรับสต๊อค
  const { data: adjustment, error: adjErr } = await supabase
    .from('inv_adjustments')
    .insert({
      adjust_no: adjustNo,
      status: 'pending',
      created_by: userId,
      note: `ปรับสต๊อคจากผล Audit ${audit.audit_no}`,
    })
    .select('*')
    .single()
  if (adjErr) throw adjErr

  // สร้าง adjustment items จาก variance
  if (varianceItems.length) {
    const adjItems = varianceItems.map((item) => ({
      adjustment_id: adjustment.id,
      product_id: item.product_id,
      qty_delta: Number(item.variance),
      new_safety_stock: item.safety_stock_match === false && item.counted_safety_stock != null
        ? item.counted_safety_stock
        : null,
    }))
    const { error: itemErr } = await supabase.from('inv_adjustment_items').insert(adjItems)
    if (itemErr) throw itemErr
  }

  // อัปเดต storage_location สำหรับรายการที่จุดเก็บไม่ตรง
  if (locationItems.length) {
    for (const item of locationItems) {
      await supabase
        .from('pr_products')
        .update({ storage_location: item.actual_location })
        .eq('id', item.product_id)
    }
  }

  // เชื่อม audit กับ adjustment
  await supabase
    .from('inv_audits')
    .update({ adjustment_id: adjustment.id })
    .eq('id', auditId)

  return adjustment
}

// ── KPI ──────────────────────────────────────────────────────

export interface AuditKPI {
  totalAudits: number
  avgQuantityAccuracy: number | null
  avgLocationAccuracy: number | null
  avgSafetyStockAccuracy: number | null
  totalItemsAudited: number
  auditsByMonth: { month: string; count: number; accuracy: number }[]
}

export async function getAuditKPI(): Promise<AuditKPI> {
  const { data: audits, error } = await supabase
    .from('inv_audits')
    .select('id, status, accuracy_percent, location_accuracy_percent, safety_stock_accuracy_percent, total_items, created_at')
    .in('status', ['completed', 'closed', 'review'])
    .order('created_at', { ascending: false })
  if (error) throw error

  const completedAudits = audits || []
  const totalAudits = completedAudits.length

  const withQtyAccuracy = completedAudits.filter((a) => a.accuracy_percent != null)
  const avgQuantityAccuracy = withQtyAccuracy.length > 0
    ? withQtyAccuracy.reduce((sum, a) => sum + Number(a.accuracy_percent), 0) / withQtyAccuracy.length
    : null

  const withLocAccuracy = completedAudits.filter((a) => a.location_accuracy_percent != null)
  const avgLocationAccuracy = withLocAccuracy.length > 0
    ? withLocAccuracy.reduce((sum, a) => sum + Number(a.location_accuracy_percent), 0) / withLocAccuracy.length
    : null

  const withSafetyAccuracy = completedAudits.filter((a) => a.safety_stock_accuracy_percent != null)
  const avgSafetyStockAccuracy = withSafetyAccuracy.length > 0
    ? withSafetyAccuracy.reduce((sum, a) => sum + Number(a.safety_stock_accuracy_percent), 0) / withSafetyAccuracy.length
    : null

  const totalItemsAudited = completedAudits.reduce((sum, a) => sum + Number(a.total_items || 0), 0)

  // Group by month
  const monthMap: Record<string, { count: number; totalAccuracy: number; items: number }> = {}
  completedAudits.forEach((a) => {
    const month = a.created_at.substring(0, 7)
    if (!monthMap[month]) monthMap[month] = { count: 0, totalAccuracy: 0, items: 0 }
    monthMap[month].count++
    monthMap[month].totalAccuracy += Number(a.accuracy_percent || 0)
    monthMap[month].items++
  })
  const auditsByMonth = Object.entries(monthMap)
    .map(([month, data]) => ({
      month,
      count: data.count,
      accuracy: data.items > 0 ? data.totalAccuracy / data.items : 0,
    }))
    .sort((a, b) => a.month.localeCompare(b.month))

  return {
    totalAudits,
    avgQuantityAccuracy,
    avgLocationAccuracy,
    avgSafetyStockAccuracy,
    totalItemsAudited,
    auditsByMonth,
  }
}

// ── Utility: Fetch distinct categories and locations ─────────

export async function fetchDistinctCategories(): Promise<string[]> {
  const { data, error } = await supabase
    .from('pr_products')
    .select('product_category')
    .eq('is_active', true)
    .not('product_category', 'is', null)
  if (error) throw error
  const unique = [...new Set((data || []).map((d: any) => d.product_category).filter(Boolean))]
  return unique.sort()
}

export async function fetchDistinctLocations(): Promise<string[]> {
  const { data, error } = await supabase
    .from('pr_products')
    .select('storage_location')
    .eq('is_active', true)
    .not('storage_location', 'is', null)
  if (error) throw error
  const unique = [...new Set((data || []).map((d: any) => d.storage_location).filter(Boolean))]
  return unique.sort()
}

export async function fetchAuditors(): Promise<{ id: string; username: string }[]> {
  const { data, error } = await supabase
    .from('us_users')
    .select('id, username')
    .eq('role', 'auditor')
  if (error) throw error
  return (data || []) as { id: string; username: string }[]
}
