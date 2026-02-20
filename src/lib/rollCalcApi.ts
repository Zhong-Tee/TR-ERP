import { supabase } from './supabase'
import type {
  RollMaterialCategory,
  RollCalcDashboardRow,
  Product,
} from '../types'

// ── Dashboard (single RPC) ──────────────────────────────

export async function fetchRollCalcDashboard(): Promise<RollCalcDashboardRow[]> {
  const { data, error } = await supabase.rpc('fn_get_roll_calc_dashboard')
  if (error) throw error
  return (data ?? []) as RollCalcDashboardRow[]
}

// ── Categories ──────────────────────────────────────────

export async function fetchRollCategories(): Promise<RollMaterialCategory[]> {
  const { data, error } = await supabase
    .from('roll_material_categories')
    .select('*')
    .order('sort_order')
    .order('name')
  if (error) throw error
  return (data ?? []) as RollMaterialCategory[]
}

export async function createRollCategory(name: string): Promise<RollMaterialCategory> {
  const { data, error } = await supabase
    .from('roll_material_categories')
    .insert({ name })
    .select()
    .single()
  if (error) throw error
  return data as RollMaterialCategory
}

export async function deleteRollCategory(id: string): Promise<void> {
  const { error } = await supabase
    .from('roll_material_categories')
    .delete()
    .eq('id', id)
  if (error) throw error
}

// ── Configs ─────────────────────────────────────────────

export async function upsertRollConfig(params: {
  fg_product_id: string
  rm_product_id: string
  category_id?: string | null
  sheets_per_roll?: number | null
  cost_per_sheet?: number | null
}): Promise<string> {
  const { data, error } = await supabase.rpc('fn_upsert_roll_config', {
    p_fg_product_id: params.fg_product_id,
    p_rm_product_id: params.rm_product_id,
    p_category_id: params.category_id ?? null,
    p_sheets: params.sheets_per_roll ?? null,
    p_cost: params.cost_per_sheet ?? null,
  })
  if (error) throw error
  return data as string
}

export async function updateRollConfigField(
  configId: string,
  field: 'sheets_per_roll' | 'cost_per_sheet' | 'category_id',
  value: number | string | null,
): Promise<void> {
  const { error } = await supabase
    .from('roll_material_configs')
    .update({ [field]: value, updated_at: new Date().toISOString() })
    .eq('id', configId)
  if (error) throw error
}

export async function deleteRollConfig(configId: string): Promise<void> {
  const { error } = await supabase
    .from('roll_material_configs')
    .delete()
    .eq('id', configId)
  if (error) throw error
}

// ── Products for pairing ────────────────────────────────

export async function fetchAvailableFgProducts(): Promise<Product[]> {
  const { data: pairedIds } = await supabase
    .from('roll_material_configs')
    .select('fg_product_id')
  const excludeIds = (pairedIds ?? []).map((r: { fg_product_id: string }) => r.fg_product_id)

  let query = supabase
    .from('pr_products')
    .select('*')
    .eq('product_type', 'FG')
    .eq('is_active', true)
    .order('product_code')

  if (excludeIds.length > 0) {
    query = query.not('id', 'in', `(${excludeIds.join(',')})`)
  }

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as Product[]
}

export async function fetchAvailableRmProducts(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('pr_products')
    .select('*')
    .eq('product_type', 'RM')
    .eq('is_active', true)
    .order('product_code')
  if (error) throw error
  return (data ?? []) as Product[]
}

// ── Manual usage log ────────────────────────────────────

export async function addManualUsageLog(
  rmProductId: string,
  qty: number,
  eventDate?: string,
): Promise<void> {
  const { error } = await supabase
    .from('roll_usage_logs')
    .insert({
      rm_product_id: rmProductId,
      qty,
      source_type: 'manual',
      event_date: eventDate || new Date().toISOString(),
    })
  if (error) throw error
}
