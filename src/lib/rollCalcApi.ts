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

export async function createRollPairingGroup(rmId: string, fgIds: string[], sheets: number): Promise<void> {
  const { error } = await supabase.rpc('rpc_create_roll_pairing_group', {
    p_rm_id: rmId, p_fg_ids: fgIds, p_sheets: sheets,
  })
  if (error) throw error
}

export async function updateRollConfigField(
  configId: string,
  field: 'sheets_per_roll' | 'category_id',
  value: number | string | null,
): Promise<void> {
  const { error } = field === 'sheets_per_roll'
    ? await supabase.rpc('rpc_update_roll_group_sheets', { p_config_id: configId, p_sheets: value })
    : await supabase.from('roll_material_configs').update({ [field]: value, updated_at: new Date().toISOString() }).eq('id', configId)
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
  const query = supabase
    .from('pr_products')
    .select('*')
    .eq('product_type', 'FG')
    .eq('is_active', true)
    .order('product_code')

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

