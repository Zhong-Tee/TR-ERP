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
  rm_product_ids: string[]
  category_id?: string | null
  sheets_per_roll?: number | null
}): Promise<string> {
  const rmIds = (params.rm_product_ids ?? []).filter(Boolean)
  if (!params.fg_product_id || rmIds.length === 0) {
    throw new Error('ต้องเลือก FG และ RM อย่างน้อย 1 รายการ')
  }

  const { data: cfg, error: upsertError } = await supabase
    .from('roll_material_configs')
    .upsert(
      {
        fg_product_id: params.fg_product_id,
        rm_product_id: rmIds[0],
        category_id: params.category_id ?? null,
        sheets_per_roll: params.sheets_per_roll ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'fg_product_id' },
    )
    .select('id')
    .single()

  if (upsertError) throw upsertError
  const configId = cfg?.id as string

  const { error: deleteMapError } = await supabase
    .from('roll_material_config_rms')
    .delete()
    .eq('config_id', configId)
  if (deleteMapError) throw deleteMapError

  const mapRows = rmIds.map((rmId) => ({ config_id: configId, rm_product_id: rmId }))
  const { error: insertMapError } = await supabase
    .from('roll_material_config_rms')
    .insert(mapRows)
  if (insertMapError) throw insertMapError

  return configId
}

export async function updateRollConfigField(
  configId: string,
  field: 'sheets_per_roll' | 'category_id',
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

