import { supabase } from './supabase'
import type {
  Product,
  PpRecipe,
  PpRecipeInclude,
  PpRecipeRemove,
  PpProductionOrder,
  PpProductionOrderItem,
  ProductionOrderStatus,
} from '../types'

// ── PP Products ──────────────────────────────────────────────

export async function fetchPPProducts() {
  const { data: products, error: pErr } = await supabase
    .from('pr_products')
    .select('*')
    .eq('product_type', 'PP')
    .eq('is_active', true)
    .order('product_code')

  if (pErr) throw pErr

  const ids = (products ?? []).map((p: Product) => p.id)
  if (ids.length === 0) return []

  const { data: balances } = await supabase
    .from('inv_stock_balances')
    .select('product_id, on_hand')
    .in('product_id', ids)

  const balMap = new Map((balances ?? []).map((b: { product_id: string; on_hand: number }) => [b.product_id, b.on_hand]))

  return (products ?? []).map((p: Product) => ({
    ...p,
    on_hand: (balMap.get(p.id) as number) ?? 0,
  }))
}

export async function calcProducibleQty(productId: string): Promise<number> {
  const { data, error } = await supabase.rpc('fn_calc_pp_producible_qty', {
    p_product_id: productId,
  })
  if (error) throw error
  return Number(data) || 0
}

export async function calcProducibleQtyBatch(
  productIds: string[]
): Promise<Record<string, number>> {
  if (productIds.length === 0) return {}
  const { data, error } = await supabase.rpc('fn_calc_pp_producible_qty_batch', {
    p_product_ids: productIds,
  })
  if (error) throw error
  const map: Record<string, number> = {}
  for (const row of (data ?? []) as { product_id: string; producible_qty: number }[]) {
    map[row.product_id] = Number(row.producible_qty) || 0
  }
  return map
}

// ── Recipes ──────────────────────────────────────────────────

export async function fetchRecipe(productId: string) {
  const { data: recipe, error: rErr } = await supabase
    .from('pp_recipes')
    .select('*')
    .eq('product_id', productId)
    .maybeSingle()

  if (rErr) throw rErr
  if (!recipe) return null

  const [{ data: includes }, { data: removes }] = await Promise.all([
    supabase
      .from('pp_recipe_includes')
      .select('*, product:pr_products(*)')
      .eq('recipe_id', recipe.id),
    supabase
      .from('pp_recipe_removes')
      .select('*, product:pr_products(*)')
      .eq('recipe_id', recipe.id),
  ])

  return {
    recipe: recipe as PpRecipe,
    includes: (includes ?? []) as PpRecipeInclude[],
    removes: (removes ?? []) as PpRecipeRemove[],
  }
}

export async function saveRecipe(
  productId: string,
  userId: string,
  includes: { product_id: string; qty: number }[],
  removes: { product_id: string; qty: number; unit_cost: number }[]
) {
  let recipeId: string

  const { data: existing } = await supabase
    .from('pp_recipes')
    .select('id')
    .eq('product_id', productId)
    .maybeSingle()

  if (existing) {
    recipeId = existing.id
    await supabase
      .from('pp_recipes')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', recipeId)
  } else {
    const { data: newRecipe, error } = await supabase
      .from('pp_recipes')
      .insert({ product_id: productId, created_by: userId })
      .select('id')
      .single()
    if (error) throw error
    recipeId = newRecipe.id
  }

  await supabase.from('pp_recipe_includes').delete().eq('recipe_id', recipeId)
  await supabase.from('pp_recipe_removes').delete().eq('recipe_id', recipeId)

  if (includes.length > 0) {
    const { error: iErr } = await supabase
      .from('pp_recipe_includes')
      .insert(includes.map((i) => ({ recipe_id: recipeId, product_id: i.product_id, qty: i.qty })))
    if (iErr) throw iErr
  }

  if (removes.length > 0) {
    const { error: rErr } = await supabase
      .from('pp_recipe_removes')
      .insert(removes.map((r) => ({ recipe_id: recipeId, product_id: r.product_id, qty: r.qty, unit_cost: r.unit_cost })))
    if (rErr) throw rErr
  }

  return recipeId
}

// ── Validate RM stock before submit ──────────────────────────

export async function validateProductionItems(
  items: { product_id: string; qty: number }[]
): Promise<{ valid: boolean; errors: string[] }> {
  if (items.length === 0) return { valid: true, errors: [] }

  const { data, error } = await supabase.rpc('fn_validate_production_items_batch', {
    p_items: items.map(i => ({ product_id: i.product_id, qty: i.qty })),
  })
  if (error) throw error

  const errors = ((data ?? []) as { include_product_code: string; needed: number; on_hand: number }[])
    .map(r => `${r.include_product_code} ต้องการ ${r.needed} คงเหลือ ${r.on_hand}`)

  return { valid: errors.length === 0, errors }
}

// ── Fetch all FG/RM products (for recipe selection) ─────────

export async function fetchFgRmProducts() {
  const { data, error } = await supabase
    .from('pr_products')
    .select('*')
    .in('product_type', ['FG', 'RM'])
    .eq('is_active', true)
    .order('product_code')
  if (error) throw error
  return (data ?? []) as Product[]
}

// ── Recipe product IDs (PP products that have a recipe) ─────

export async function fetchRecipeProductIds(): Promise<string[]> {
  const { data, error } = await supabase
    .from('pp_recipes')
    .select('product_id')
  if (error) throw error
  return (data ?? []).map((r: { product_id: string }) => r.product_id)
}

// ── Production Orders ────────────────────────────────────────

export async function fetchProductionOrders(status?: ProductionOrderStatus) {
  let q = supabase
    .from('pp_production_orders')
    .select('*')
    .order('created_at', { ascending: false })

  if (status) {
    q = q.eq('status', status)
  }

  const { data, error } = await q
  if (error) throw error

  const orders = (data ?? []) as PpProductionOrder[]

  const userIds = [...new Set(
    orders.flatMap(o => [o.created_by, o.approved_by, o.rejected_by].filter(Boolean) as string[])
  )]
  if (userIds.length > 0) {
    const { data: users } = await supabase
      .from('us_users')
      .select('id, username')
      .in('id', userIds)
    const userMap = new Map(
      (users ?? []).map((u: { id: string; username: string }) => [u.id, u.username])
    )
    orders.forEach(o => {
      if (o.created_by) o.creator = { display_name: userMap.get(o.created_by) || '-' }
      if (o.approved_by) o.approver = { display_name: userMap.get(o.approved_by) || '-' }
      if (o.rejected_by) o.rejector = { display_name: userMap.get(o.rejected_by) || '-' }
    })
  }

  return orders
}

export async function fetchProductionOrderItems(orderId: string) {
  const { data, error } = await supabase
    .from('pp_production_order_items')
    .select('*, product:pr_products(*)')
    .eq('order_id', orderId)
  if (error) throw error
  return (data ?? []) as PpProductionOrderItem[]
}

export async function createProductionOrder(
  title: string,
  note: string,
  items: { product_id: string; qty: number }[],
  userId: string
) {
  const { data, error } = await supabase.rpc('rpc_create_production_order', {
    p_title: title,
    p_note: note,
    p_items: items,
    p_user_id: userId,
  })
  if (error) throw error
  return data as { id: string; doc_no: string }
}

export async function submitForApproval(orderId: string) {
  const { error } = await supabase.rpc('rpc_submit_production_order', {
    p_order_id: orderId,
  })
  if (error) throw error
}

export async function approveOrder(orderId: string, userId: string) {
  const { error } = await supabase.rpc('rpc_approve_production_order', {
    p_order_id: orderId,
    p_user_id: userId,
  })
  if (error) throw error
}

export async function rejectOrder(orderId: string, userId: string, reason: string) {
  const { error } = await supabase.rpc('rpc_reject_production_order', {
    p_order_id: orderId,
    p_user_id: userId,
    p_reason: reason,
  })
  if (error) throw error
}

export async function updateProductionOrder(
  orderId: string,
  title: string,
  note: string,
  items: { product_id: string; qty: number }[]
) {
  await supabase
    .from('pp_production_orders')
    .update({ title, note })
    .eq('id', orderId)

  await supabase
    .from('pp_production_order_items')
    .delete()
    .eq('order_id', orderId)

  if (items.length > 0) {
    const { error } = await supabase
      .from('pp_production_order_items')
      .insert(items.map((i) => ({ order_id: orderId, product_id: i.product_id, qty: i.qty })))
    if (error) throw error
  }
}

export async function deleteProductionOrder(orderId: string) {
  const { error } = await supabase
    .from('pp_production_orders')
    .delete()
    .eq('id', orderId)
  if (error) throw error
}
